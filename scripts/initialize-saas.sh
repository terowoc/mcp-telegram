#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run as root in the private /opt/mcp-telegram directory before enabling SaaS.
[[ "$(id -u)" == 0 ]] || { echo 'SaaS key provisioning requires root' >&2; exit 1; }
exec 9>.deploy.lock
flock -n 9 || { echo 'Deployment already running' >&2; exit 1; }
python3 - <<'PY'
import os, stat
for path in ['data','data/auth','data/files','backups','backups/master-key']:
    if os.path.lexists(path):
        s=os.lstat(path)
        if not stat.S_ISDIR(s.st_mode):
            raise SystemExit('Storage must be a private project directory')
path='session-key.bin'
try:
    fd=os.open(path, os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW, 0o600)
except FileExistsError:
    s=os.lstat(path)
    if not stat.S_ISREG(s.st_mode) or s.st_size!=32 or s.st_mode&0o077:
        raise SystemExit('Existing session key is invalid; it is never overwritten')
else:
    try:
        os.fchown(fd,1000,1000)
        os.write(fd,os.urandom(32))
        os.fsync(fd)
    finally:
        os.close(fd)
os.makedirs('backups/master-key',mode=0o700,exist_ok=True)
backup='backups/master-key/session-key.bin'
source=open(path,'rb').read()
try:
    fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
except FileExistsError:
    s=os.lstat(backup)
    if not stat.S_ISREG(s.st_mode) or s.st_mode&0o077 or open(backup,'rb').read()!=source:
        raise SystemExit('Private master-key backup does not match; no key is overwritten')
else:
    try:
        os.write(fd,source)
        os.fsync(fd)
    finally:
        os.close(fd)
PY
mkdir -p data/auth data/files
chown 1000:1000 data/auth data/files
chmod 700 data/auth data/files
printf 'SaaS key and private backup are ready; existing OAuth grants are not migrated.\n'
