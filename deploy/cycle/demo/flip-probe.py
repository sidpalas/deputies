#!/usr/bin/env python3
"""Load probe and analysis for flip-test.sh.

flip-probe.py probe HOST IP OUTLOG [THREADS] [http]
  Opens a fresh connection per request to IP (TLS with SNI/Host=HOST, or
  plain HTTP on port 80 with "http"). Logs one line per request:
start_ms end_ms status version_name   (version from whoami 'Name:' line)
Non-200 responses also get headers+body (first 300 bytes) logged on the next line prefixed '#'."""
import socket, ssl, sys, threading, time

def analyze(probe_log, flips_log):
    """flips_log lines: n target_version queued_ms started_ms completed_ms"""
    reqs, notes = [], {}
    for line in open(probe_log):
        if line.startswith("#"):
            notes[len(reqs) - 1] = line[2:].strip(); continue
        parts = line.split()
        if len(parts) < 3 or not parts[0].isdigit(): continue  # stray body lines
        a, b, st, name = parts[0], parts[1], parts[2], (parts[3] if len(parts) > 3 else "-")
        reqs.append((int(a), int(b), st, name))
    flips = [l.split() for l in open(flips_log) if l.strip()]
    tot_fail = 0
    print("flip target  job_ms  switch: last_old->first_new (ms after job done)  failed/total  errors (ms after job done)")
    for k, (n, tgt, q, s0, c) in enumerate(flips):
        q, c = int(q), int(c)
        end = int(flips[k + 1][2]) - 1000 if k + 1 < len(flips) else c + 8000
        win = [(i, r) for i, r in enumerate(reqs) if q - 1000 <= r[0] < end]
        fails = [(i, r) for i, r in win if r[2] != "200"]
        tot_fail += len(fails)
        old = [r for _, r in win if r[2] == "200" and r[3] != tgt]
        new = [r for _, r in win if r[2] == "200" and r[3] == tgt]
        last_old = max((r[1] for r in old), default=None)
        first_new = min((r[1] for r in new), default=None)
        sw = f"{(last_old - c) if last_old else '-'}->{(first_new - c) if first_new else '-'}"
        errs = "; ".join(f"{r[2]}@{r[0]-c:+d} {notes.get(i, '').split('|')[-1].strip()[:60]}" for i, r in fails)
        tail = [r for _, r in win if r[0] >= end - 2000 and r[2] == "200"]
        stale = sum(1 for r in tail if r[3] != tgt)
        print(f"{n:>4} {tgt:>6}  {c-q:>6}  {sw:>22}  {len(fails)}/{len(win)}  old-in-last-2s {stale}/{len(tail)}  {errs}")

    print(f"total failed requests in flip windows: {tot_fail}; all requests: {len(reqs)}, failed overall: {sum(1 for r in reqs if r[2] != '200')}")

if sys.argv[1] == "analyze":
    analyze(sys.argv[2], sys.argv[3]); sys.exit()
host, ip, out = sys.argv[2], sys.argv[3], sys.argv[4]
threads = int(sys.argv[5]) if len(sys.argv) > 5 else 4
plain = len(sys.argv) > 6 and sys.argv[6] == "http"  # port 80, no TLS
path = "/"
ctx = ssl.create_default_context()
lock = threading.Lock()
f = open(out, "a", buffering=1)
def one():
    t0 = int(time.time() * 1000)
    status, name, raw = "000", "-", b""
    try:
        s = socket.create_connection((ip, 80 if plain else 443), timeout=3)
        if not plain: s = ctx.wrap_socket(s, server_hostname=host)
        s.settimeout(3)
        s.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
        while True:
            b = s.recv(65536)
            if not b: break
            raw += b
        s.close()
        status = raw.split(b" ", 2)[1].decode() if raw.startswith(b"HTTP/") else "bad"
        for line in raw.split(b"\n"):
            if line.startswith(b"Name: "): name = line[6:].strip().decode(); break
    except Exception as e:
        raw = f"EXC {type(e).__name__}: {e}".encode()
    t1 = int(time.time() * 1000)
    with lock:
        f.write(f"{t0} {t1} {status} {name}\n")
        if status != "200":
            f.write("# " + raw[:400].decode("utf-8", "replace").replace("\r\n", " | ").replace("\n", " | ") + "\n")
def loop():
    while True:
        one(); time.sleep(0.05)
for _ in range(threads): threading.Thread(target=loop, daemon=True).start()
while True: time.sleep(3600)
