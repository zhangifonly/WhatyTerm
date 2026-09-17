# -*- coding: utf-8 -*-
"""原版 SessionLoop 的对拍驱动（tests/test-longrun-parity.mjs 调用）。

stdin 收场景列表，逐个用原版测试同款的 StubRunner / StubClient 驱动原版 SessionLoop，
stdout 回每个场景的派发序列、停机结果与落盘事件类型序列。
不建真实沙箱（原版 SandboxSpec.create 需要模板目录并会写用户级 ~/.claude.json），
用一个只含 SessionLoop 所需属性的轻量 spec，工作目录放临时目录。
"""
import json, os, sys, tempfile, shutil
from pathlib import Path

ROOT = sys.argv[1]
sys.path.insert(0, ROOT)
from orchestrator import session_loop as SL
from orchestrator.llm_client import LLMReply, LLMError, LLMConfig
from orchestrator.prompts import CONTINUE, load_prompts
from orchestrator.runner import ExitReason, RunResult
from orchestrator.session_loop import SessionLoop
from orchestrator.supervisor import Supervisor

PROMPTS = load_prompts(Path(ROOT) / "提示词.txt")


class Spec:
    def __init__(self, root):
        self.root = Path(root)
        self.memory_dir = self.root / ".memory"
        self.run_dir = self.root / ".run"
        self.extra_dirs = []
        for d in (self.root, self.memory_dir, self.run_dir):
            d.mkdir(parents=True, exist_ok=True)

    def verify_clean(self):
        pass

    def child_env(self):
        return dict(os.environ)


class StubRunner:
    script, sent = [], []
    cost_each = estimate_each = 0.0
    inject_next = ""

    def __init__(self, *_, **kw):
        self.kill_at = kw.get("context_limit")
        self.cost_ceiling = kw.get("cost_ceiling")

    def run(self, prompt, session_id=None, resume=False):
        StubRunner.sent.append((prompt, resume, self.kill_at, self.cost_ceiling))
        if not StubRunner.script:
            raise AssertionError("脚本已空但仍在派发")
        reason, peak, text = StubRunner.script.pop(0)
        return RunResult(
            session_id=session_id or f"sid-{len(StubRunner.sent)}",
            exit_reason=ExitReason(reason), exit_code=0, context_peak=peak,
            final_text=text, stop_reason="end_turn",
            cost_usd=StubRunner.cost_each, cost_estimate=StubRunner.estimate_each,
            inject_text=(StubRunner.inject_next if reason == "interrupted_by_human" else ""),
        )


class StubClient:
    def __init__(self, verdicts):
        self.verdicts = verdicts
        self.config = LLMConfig(base_url="stub", api_key="stub")

    def complete(self, system, user):
        v = self.verdicts[0] if len(self.verdicts) == 1 else self.verdicts.pop(0)
        if isinstance(v, dict):
            if "error" in v:
                raise LLMError(v["error"])
            return LLMReply(text=v["raw"], stop_reason=v.get("stop", "end_turn"), input_tokens=10, output_tokens=10)
        conf = 0.95
        if isinstance(v, list):
            v, conf = v
        reply = "用 InstancedMesh 实现，不引入额外依赖" if v == "decide" else ""
        return LLMReply(
            text='{"verdict":"%s","confidence":%s,"reason":"stub","reply":"%s","needs_from_human":"确认方案"}' % (v, conf, reply),
            stop_reason="end_turn", input_tokens=10, output_tokens=10)


def label(text):
    known = [(PROMPTS.init, "init"), (PROMPTS.wrapup, "wrapup"), (PROMPTS.resume, "resume"),
             (PROMPTS.maintain_1, "maintain1"), (PROMPTS.maintain_2, "maintain2"), (CONTINUE, "continue")]
    hit = next((n for body, n in known if text == body), None)
    return hit or ("requirement" if "缓存装饰器" in text else text)


SL.ClaudeRunner = StubRunner
# 原版 log() 直接 print 到 stdout，会和本驱动输出的 JSON 混在一起 —— 运行期间改道到 stderr
REAL_STDOUT, sys.stdout = sys.stdout, sys.stderr
out = []
for sc in json.load(sys.stdin):
    tmp = tempfile.mkdtemp(prefix="parity_py_")
    StubRunner.script = [tuple(x) for x in sc["script"]]
    StubRunner.sent = []
    StubRunner.cost_each = sc.get("cost_each", 0.0)
    StubRunner.estimate_each = sc.get("estimate_each", 0.0)
    StubRunner.inject_next = sc.get("inject_next", "")
    sup = Supervisor(client=StubClient(list(sc["verdicts"]))) if sc["verdicts"] else None
    kw = dict(total_budget_usd=999.0, ask_human=False)
    kw.update(sc.get("kw", {}))
    loop = SessionLoop(Spec(tmp), PROMPTS, "做一个缓存装饰器。", supervisor=sup, **kw)
    if sc.get("inject_file"):
        (loop.spec.run_dir / "inject.txt").write_text(sc["inject_file"], encoding="utf-8")
    try:
        rep = loop.run()
        res = {"stop": rep.stop.value, "needs": rep.needs_from_human, "legs": rep.legs, "handoffs": rep.handoffs,
               "maintenances": rep.maintenances, "decisions": rep.decisions, "spent": round(loop.spent_usd, 6)}
    except Exception as exc:
        res = {"crash": type(exc).__name__}
    res["sent"] = [[label(p), r, k, None if c is None else round(c, 6)] for p, r, k, c in StubRunner.sent]
    evp = loop.spec.run_dir / "orchestrator.jsonl"
    res["events"] = [json.loads(l)["kind"] for l in evp.read_text(encoding="utf-8").splitlines()] if evp.exists() else []
    state = loop.spec.run_dir / "session_state.json"
    res["state_keys"] = sorted(json.loads(state.read_text(encoding="utf-8"))) if state.exists() else []
    report = loop.spec.run_dir / "report.json"
    res["report_keys"] = sorted(json.loads(report.read_text(encoding="utf-8"))) if report.exists() else []
    out.append(res)
    shutil.rmtree(tmp, ignore_errors=True)
REAL_STDOUT.write(json.dumps(out, ensure_ascii=False))
