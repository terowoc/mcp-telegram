"""Private, bounded JSON worker. Authentication and persistence belong to Node."""
import base64
import importlib.metadata
import json
import logging
import queue
import re
import sys
import threading

MAX_FRAME = 262144
STATE_KEYS = {"uuids", "mid", "ig_u_rur", "ig_www_claim", "authorization_data", "cookies", "last_login", "device_settings", "user_agent", "country", "country_code", "locale", "timezone_offset", "timezone_name", "push_disabled", "usdid"}

class SafeError(Exception):
    pass

def error_code(error):
    if isinstance(error, SafeError): return str(error)
    name = type(error).__name__
    if name in {"LoginRequired", "ClientLoginRequired"}: return "needs-login"
    if name in {"TwoFactorRequired", "CAA2FARequired", "Bloks2FARequired"}: return "needs-code"
    if "Challenge" in name or "Captcha" in name or name == "SelectContactPointRecoveryForm": return "needs-verification"
    if name in {"RateLimitError", "PleaseWaitFewMinutes", "FeedbackRequired", "ClientThrottledError"}: return "rate-limited"
    if name in {"BadPassword", "BadCredentials", "InvalidUser", "UserNotFound"}: return "login-failed"
    if "Code" in name or "TwoFactor" in name: return "invalid-code"
    return "worker-unavailable"

def identity(value):
    result = {"id": str(value.pk)}
    if value.username: result["username"] = str(value.username)[:64]
    if not re.fullmatch(r"[1-9]\d{0,63}", result["id"]): raise SafeError("identity-mismatch")
    return result

def stamp(value):
    return value.isoformat() if hasattr(value,"isoformat") else str(value or "")

def configure(client):
    client.tls_verify = True
    client.session_retry_total = 0
    client.session_retry_statuses = []
    client.public_request_retries_count = 0
    client.request_timeout = 1
    if hasattr(client,"_configure_private_session_retry"): client._configure_private_session_retry()

def make_client():
    from instagrapi import Client
    class SingleAttemptClient(Client):
        # The pinned wrapper retries timeouts and even failed POSTs after challenges.
        # Bypass that wrapper, retaining its authorization and low-level encoding.
        def private_request(self, endpoint, data=None, params=None, login=False, with_signature=True, headers=None, extra_sig=None, domain=None):
            headers = dict(headers or {})
            if self.authorization: headers.setdefault("Authorization",self.authorization)
            self._send_private_request(endpoint,data=data,params=params,login=login,with_signature=with_signature,headers=headers,extra_sig=extra_sig,domain=domain)
            return self.last_json
    client = SingleAttemptClient(tls_verify=True, session_retry_total=0, session_retry_statuses=[], public_request_retries_count=0)
    # requests and curl transports both consume request kwargs; provide a hard
    # per-request deadline even for library calls that omit timeout arguments.
    for session in (client.private, client.public):
        original = session.request
        def bounded(method,url,_request=original,**kwargs):
            kwargs["timeout"] = 15
            return _request(method,url,**kwargs)
        session.request = bounded
    configure(client)
    return client

class Adapter:
    def __init__(self,client): self.client=client; configure(client)
    def restore(self,state,expected_id):
        self.client.set_settings(state); configure(self.client)
        account=identity(self.client.account_info())
        if expected_id and account["id"] != expected_id: raise SafeError("identity-mismatch")
        return account
    def settings(self): return {k:v for k,v in self.client.get_settings().items() if k in STATE_KEYS}
    def tool(self,name,args,policy):
        allowed=policy.get("threadIds",[])
        if name not in {"instagram-list-chats","instagram-read-messages","instagram-send-message"}: raise SafeError("permission-denied")
        if name != "instagram-list-chats":
            thread=args.get("threadId","")
            if not re.fullmatch(r"[1-9]\d{0,63}",thread) or (allowed and thread not in allowed): raise SafeError("permission-denied")
        if name == "instagram-send-message":
            text=args.get("text","")
            if policy["profile"] != "full" or not 1 <= len(text) <= 1000: raise SafeError("permission-denied")
            m=self.client.direct_send(text,thread_ids=[int(thread)])
            return {"id":str(m.id),"timestamp":stamp(m.timestamp)}
        limit=args.get("limit",20)
        if not isinstance(limit,int) or isinstance(limit,bool) or not 1 <= limit <= (20 if name == "instagram-list-chats" else 50): raise SafeError("invalid-request")
        if name == "instagram-read-messages":
            items=self.client.direct_thread(int(thread),amount=limit).messages
            return {"threadId":thread,"messages":[{"id":str(m.id),"senderId":str(m.user_id),"timestamp":stamp(m.timestamp),"kind":str(m.item_type),"text":str(m.text or "")[:10000]} for m in items[:limit]]}
        cursor=None; offset=0
        if args.get("cursor"):
            try:
                parsed=json.loads(base64.urlsafe_b64decode(args["cursor"]+"="*(-len(args["cursor"])%4)))
                cursor=parsed["cursor"]; offset=parsed["offset"]
                if cursor is not None and (not isinstance(cursor,str) or len(cursor)>1024): raise ValueError()
                if not isinstance(offset,int) or not 0<=offset<=100: raise ValueError()
            except Exception: raise SafeError("invalid-cursor")
        out=[]; next_cursor=None
        for _ in range(3):
            items,next_page=self.client.direct_threads_chunk(cursor=cursor,thread_message_limit=1)
            selected=items[offset:]
            for index,t in enumerate(selected,offset):
                if not allowed or str(t.id) in allowed:
                    out.append({"id":str(t.id),"title":str(t.thread_title)[:256],"participants":[{"id":str(u.pk),"username":str(u.username or "")[:64]} for u in t.users[:50]]})
                if len(out)>=limit:
                    if index+1<len(items): next_cursor={"cursor":cursor,"offset":index+1}
                    elif next_page: next_cursor={"cursor":next_page,"offset":0}
                    break
            if len(out)>=limit or not next_page: break
            cursor=next_page; offset=0; next_cursor={"cursor":cursor,"offset":0}
        if len(out)<limit and not next_page: next_cursor=None
        result={"chats":out}
        if next_cursor: result["nextCursor"]=base64.urlsafe_b64encode(json.dumps(next_cursor,separators=(",",":")).encode()).decode().rstrip("=")
        return result

def main():
    logging.disable(logging.CRITICAL)
    if len(sys.argv)>1 and sys.argv[1]=="--check":
        if importlib.metadata.version("instagrapi")!="3.0.18": raise SafeError("invalid-runtime")
        make_client(); print("instagram-runtime-ok",flush=True); return
    adapter=Adapter(make_client()); generation=None; policy=None; expected_id=None
    output_lock=threading.Lock(); tasks=queue.Queue(maxsize=5); credentials={}; attempt=None; account=None
    def emit(frame):
        frame["generation"]=generation
        data=json.dumps(frame,separators=(",",":"),ensure_ascii=False)
        if len(data.encode())>MAX_FRAME: data=json.dumps({"generation":generation,"kind":"result","id":frame.get("id"),"error":"output-too-large"})
        with output_lock: print(data,flush=True)
    def task(frame):
        nonlocal attempt, account, expected_id
        try:
            kind=frame["kind"]
            if kind=="init":
                if frame.get("session"):
                    try:
                        account=adapter.restore(frame["session"],expected_id)
                        emit({"kind":"session","account":account,"session":adapter.settings()})
                    except Exception as error:
                        emit({"kind":"ready","error":error_code(error)}); return
                emit({"kind":"ready"}); return
            if kind in {"login","code"}:
                if kind=="login": credentials.update(frame["credentials"]); attempt=frame["attemptId"]
                if frame["attemptId"]!=attempt: raise SafeError("not-found")
                try:
                    adapter.client.login(credentials["username"],credentials["password"],verification_code=frame.get("code",""))
                    account=identity(adapter.client.account_info())
                    if expected_id and account["id"]!=expected_id: raise SafeError("identity-mismatch")
                    expected_id=account["id"]
                    emit({"kind":"session","account":account,"session":adapter.settings(),"attemptId":attempt})
                    emit({"kind":"event","attemptId":attempt,"state":"connected"})
                    credentials.clear(); adapter.client.password=None
                except Exception as error:
                    code=error_code(error)
                    if code=="invalid-code": state="needs-code"
                    elif code in {"needs-code","needs-verification"}: state=code
                    else: state="failed"
                    emit({"kind":"event","attemptId":attempt,"state":state,"error":code})
                    if state!="needs-code": credentials.clear(); adapter.client.password=None
                return
            if kind=="tool":
                result=adapter.tool(frame["name"],frame["args"],policy)
                # Refresh credentials before a result; Node validates ownership/generation.
                emit({"kind":"session","account":account or {"id":expected_id},"session":adapter.settings()})
                emit({"kind":"result","id":frame["id"],"result":result})
        except Exception as error: emit({"kind":"result","id":frame.get("id"),"error":error_code(error)})
        finally:
            frame.clear()
    def consume():
        while True: task(tasks.get())
    threading.Thread(target=consume,daemon=True).start()
    for line in sys.stdin.buffer:
        if len(line)>MAX_FRAME: return
        try: frame=json.loads(line)
        except Exception: return
        if frame.get("kind")=="shutdown": return
        if generation is None:
            if frame.get("kind")!="init": return
            generation=frame["generation"]; policy=frame["policy"]; expected_id=frame.get("expectedId")
        if frame.get("generation")!=generation: return
        try: tasks.put_nowait(frame)
        except queue.Full: return

if __name__=="__main__":
    try: main()
    except Exception: sys.exit(1)
