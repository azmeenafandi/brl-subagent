#!/usr/bin/env python3
"""Apply a single FIND->REPLACE mutation to src/session-manager.ts, verify uniqueness."""
import sys, json

PATH = 'src/session-manager.ts'

MUTS = {
"S1": ("""agent.status = isSubagentError(result) ? 'failed' : 'completed';""",
       """agent.status = 'completed';"""),
"S2": ("""if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'stopped') {""",
       """if (agent.status === 'completed') {"""),
"S3": ("""if (agent.status !== 'running') {""",
       """if (false) {"""),
"S4": ("""agent.status = 'steered';""",
       """agent.status = 'running';"""),
"S5": ("""assertSafeAgentId(agent.id);""",
       """void agent.id;"""),
"S6a": ("""  try {
    assertSafeAgentId(id);""",
        """  try {
    void id;"""),
"S6b": ("""  assertSafeAgentId(id);
  return join('.pi', 'output', `agent-${id}.jsonl`);""",
        """  return join('.pi', 'output', `agent-${id}.jsonl`);"""),
"S7": ("""const gitCwd = params.cwd ?? ctx.cwd;""",
       """const gitCwd = ctx.cwd;"""),
"S8": ("""if (gitBranchLocks.get(lockKey) === entry) gitBranchLocks.delete(lockKey);""",
       """gitBranchLocks.delete(lockKey);"""),
"S9": ("""if (status === 'completed' || status === 'failed' || status === 'stopped') {""",
       """if (status === 'completed') {"""),
"S10": ("""} else if (status === 'failed') {""",
        """} else if (false) {"""),
"S11": ("""return 'Run ended with a provider error (stopReason "error")';""",
        """return 'Run ended without completing';"""),
"S12": ("""const assistants = [...session.messages].reverse().filter(m => m.role === 'assistant');""",
        """const assistants = [...session.messages].filter(m => m.role === 'assistant');"""),
"S13": ("""if (runFinalized) return;""",
        """if (false) return;"""),
"S17": ("""if (text.trim()) return text;""",
        """return text;"""),
}

name = sys.argv[1]
action = sys.argv[2] if len(sys.argv) > 2 else 'apply'
find, repl = MUTS[name]
content = open(PATH).read()
c = content.count(find)
if c != 1:
    print(f"UNVERIFIABLE: count={c} for {name}")
    sys.exit(2)
if action == 'check':
    sys.exit(0)
content = content.replace(find, repl, 1)
open(PATH, 'w').write(content)
print(f"applied {name}")
