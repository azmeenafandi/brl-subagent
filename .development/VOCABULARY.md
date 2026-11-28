# Vocabulary

The naming layer for delegated work: four concepts the code already uses, and the one synonym it bans.
`scripts/check-vocabulary.mjs` parses this table — extend the vocabulary by adding a row, never by editing
the lint. `status` is `canonical`, or `forward` for a row deliberately defined ahead of its first use;
`banned` is a comma-separated list of synonyms, each replaced by this row's `canonical` term.

| concept | canonical | banned | status | notes |
|---|---|---|---|---|
| dispatch | dispatch | | canonical | one request to delegate; a dispatch may spawn more than once, so it is not an attempt |
| spawn | spawn | | canonical | one attempt to start a subagent; retries separate it from its dispatch |
| run | run | | canonical | one execution at any level; qualify as *subagent run*, *unit run* or *mode run* when it matters |
| subagent | subagent | worker | canonical | the agent a spawn starts; always this word, never the banned synonym |
