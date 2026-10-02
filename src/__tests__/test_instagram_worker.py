import importlib.util
import pathlib
import unittest
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("ig_worker", pathlib.Path(__file__).parents[1] / "instagram" / "worker.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeClient:
    def __init__(self):
        self.user_id = "123"
        self.reads = []
        self.sends = []
    def set_settings(self, state): self.state = state
    def account_info(self): return SimpleNamespace(pk=123, username="alice")
    def login(self, *args, **kwargs): raise AssertionError("restore must not log in")
    def direct_thread(self, thread, amount):
        self.reads.append((thread,amount))
        return SimpleNamespace(messages=[SimpleNamespace(id="9000000000000000000000", user_id=123, timestamp=None, item_type="text", text="hello")])
    def direct_send(self,text,thread_ids):
        self.sends.append((text,thread_ids))
        return SimpleNamespace(id="9000000000000000000001",timestamp=None)
    def get_settings(self): return {"uuids":{}, "authorization_data":{"ds_user_id":"123"}, "cookies":{}, "request_timeout":100, "tls_verify":False}

class Tests(unittest.TestCase):
    def test_restore_and_reads_do_not_login_or_mark_seen(self):
        c=FakeClient(); w=module.Adapter(c)
        self.assertEqual(w.restore({"uuids":{},"authorization_data":{"ds_user_id":"123"}},"123")["id"],"123")
        result=w.tool("instagram-read-messages",{"threadId":"123456789012345678901234567890","limit":2},{"profile":"read","threadIds":[]})
        self.assertEqual(result["messages"][0]["id"],"9000000000000000000000")
        self.assertEqual(len(c.reads),1)
        self.assertTrue(c.tls_verify)
        self.assertEqual(c.session_retry_total,0)
    def test_write_scope_and_normalization(self):
        c=FakeClient(); w=module.Adapter(c)
        with self.assertRaises(module.SafeError): w.tool("instagram-send-message",{"threadId":"12","text":"hi"},{"profile":"read","threadIds":[]})
        with self.assertRaises(module.SafeError): w.tool("instagram-send-message",{"threadId":"12","text":"hi"},{"profile":"full","threadIds":["13"]})
        result=w.tool("instagram-send-message",{"threadId":"12","text":"hi"},{"profile":"full","threadIds":[]})
        self.assertEqual(len(c.sends),1)
        self.assertEqual(result["id"],"9000000000000000000001")
        self.assertNotIn("tls_verify",w.settings())
    def test_bounded_history_and_expired_identity(self):
        c=FakeClient(); w=module.Adapter(c)
        with self.assertRaises(module.SafeError): w.tool("instagram-read-messages",{"threadId":"12","limit":51},{"profile":"read","threadIds":[]})
        with self.assertRaises(module.SafeError): w.restore({"uuids":{},"authorization_data":{}},"456")
    def test_safe_errors_discard_exception_contents(self):
        BadPassword=type("BadPassword",(Exception,),{})
        self.assertEqual(module.error_code(BadPassword("secret-password")),"login-failed")
        self.assertEqual(module.error_code(TimeoutError("sessionid=private")),"worker-unavailable")
    def test_login_diagnostics_only_include_fixed_categories_and_status(self):
        from instagrapi.exceptions import PleaseWaitFewMinutes
        error=PleaseWaitFewMinutes("secret-password sessionid=private", response=SimpleNamespace(status_code=429))
        client=SimpleNamespace(login_request_step="device")
        self.assertEqual(module.login_diagnostic(error,client,"authentication"),
            {"phase":"authentication","reason":"please-wait","step":"device","httpStatus":429})
        Unknown=type("SecretPasswordException",(Exception,),{})
        result=module.login_diagnostic(Unknown("secret"),SimpleNamespace(login_request_step="sessionid=private"),"account-validation")
        self.assertEqual(result,{"phase":"account-validation","reason":"other","step":"other"})
        self.assertNotIn("secret",str(result))
    def test_pinned_caa_two_factor_is_actionable_without_network(self):
        from instagrapi.exceptions import TwoFactorRequired
        c=module.make_client()
        c.bloks_caa_login=lambda **kwargs: {"logged_in":False}
        c._extract_two_step_verification_context=lambda outcome: "fixture-context"
        with self.assertRaises(TwoFactorRequired) as caught:
            c.login("alice","private")
        self.assertEqual(module.error_code(caught.exception),"needs-code")
    def test_pinned_transport_does_not_retry_failed_mutation(self):
        try:
            from instagrapi.exceptions import ClientRequestTimeout
        except ImportError:
            self.skipTest("Run with the pinned Instagram environment")
        c=module.make_client(); calls=[]
        def fail(*args,**kwargs):
            calls.append(args)
            raise ClientRequestTimeout("private")
        c._send_private_request=fail
        with self.assertRaises(ClientRequestTimeout): c.private_request("direct_v2/threads/broadcast/text/",data={"text":"test"})
        self.assertEqual(len(calls),1)
        self.assertEqual(c.session_retry_total,0)
    def test_separate_graphql_preflight_transport_is_classified_without_network(self):
        from instagrapi.exceptions import ClientRequestTimeout
        c=module.make_client(); c.request_timeout=0
        def fail(*args,**kwargs): raise ClientRequestTimeout("secret")
        c.private.post=fail
        with self.assertRaises(ClientRequestTimeout) as caught:
            c.private_graphql_www_request("IGUSDIDRegistrationMutation",{})
        self.assertEqual(module.login_diagnostic(caught.exception,c,"authentication")["step"],"device")

if __name__ == "__main__": unittest.main()
