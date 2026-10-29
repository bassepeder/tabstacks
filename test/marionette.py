"""Tiny stdlib-only Marionette client + headless Firefox launcher."""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time

FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"

PREFS = {
    "browser.shell.checkDefaultBrowser": False,
    "browser.startup.homepage_override.mstone": "ignore",
    "browser.startup.page": 0,
    "browser.tabs.warnOnClose": False,
    "browser.tabs.groups.enabled": True,
    "browser.tabs.groups.smart.enabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "toolkit.telemetry.reportingpolicy.firstRun": False,
    "browser.aboutwelcome.enabled": False,
    "extensions.background.idle.timeout": 300000,
    "extensions.webextensions.remote": False,
    "app.update.disabledForTesting": True,
    "browser.newtabpage.enabled": False,
    "browser.tabs.closeWindowWithLastTab": False,
    "devtools.console.stdout.chrome": True,
    "devtools.console.stdout.content": True,
}


class Marionette:
    def __init__(self, port):
        deadline = time.time() + 30
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port))
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.2)
        self.buf = b""
        self.msg_id = 0
        self._recv()  # hello

    def _recv(self):
        while b":" not in self.buf:
            self.buf += self.sock.recv(65536)
        n, rest = self.buf.split(b":", 1)
        n = int(n)
        while len(rest) < n:
            rest += self.sock.recv(65536)
        msg, self.buf = rest[:n], rest[n:]
        return json.loads(msg)

    def send(self, cmd, params=None):
        self.msg_id += 1
        data = json.dumps([0, self.msg_id, cmd, params or {}]).encode()
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        while True:
            m = self._recv()
            if m[0] == 1 and m[1] == self.msg_id:
                if m[2]:
                    raise RuntimeError(f"{cmd}: {m[2].get('error')}: {m[2].get('message')}\n{m[2].get('stacktrace', '')[:800]}")
                return m[3]

    def js(self, script, *args):
        """Run an async chrome-context script. Body gets `args` and must `return` a value (may await)."""
        wrapped = (
            "const [args, done] = [Array.from(arguments).slice(0, -1), arguments[arguments.length - 1]];"
            f"(async () => {{ {script} }})().then(v => done(v === undefined ? null : v), e => done({{__error: String(e) + '\\n' + (e && e.stack)}}));"
        )
        r = self.send("WebDriver:ExecuteAsyncScript", {"script": wrapped, "args": list(args), "scriptTimeout": 30000})
        v = r.get("value") if isinstance(r, dict) else r
        if isinstance(v, dict) and "__error" in v:
            raise RuntimeError(v["__error"])
        return v


class Firefox:
    def __init__(self, port=2839, prefs=None):
        self.profile = tempfile.mkdtemp(prefix="tabstacks-ff-")
        prefs = dict(PREFS, **(prefs or {}), **{"marionette.port": port})
        with open(os.path.join(self.profile, "user.js"), "w") as f:
            for k, v in prefs.items():
                f.write(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n")
        self.log = open(os.path.join(self.profile, "ff.log"), "w")
        self.proc = subprocess.Popen(
            [FIREFOX, "-headless", "-marionette", "-remote-allow-system-access", "-no-remote", "-profile", self.profile],
            stdout=self.log, stderr=subprocess.STDOUT, env=dict(os.environ, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1", MOZ_HEADLESS="1"),
        )
        self.m = Marionette(port)
        self.m.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {"acceptInsecureCerts": True}}})
        self.m.send("Marionette:SetContext", {"value": "chrome"})

    def install(self, path):
        return self.m.send("Addon:Install", {"path": os.path.abspath(path), "temporary": True})["value"]

    def close(self):
        try:
            self.m.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            self.proc.wait(10)
        except Exception:
            self.proc.kill()
        self.log.close()
        with open(self.log.name, errors="replace") as f:
            self.log_text = f.read()
        shutil.rmtree(self.profile, ignore_errors=True)
