# NEXUS Control Plane

The Control Plane is how Genesis, Savannah, Aria and the Orb use AI models
without ever holding a provider's API key, and without depending on any one
AI company.

```
agent (phone)                          Control Plane (this device)              open-weight backend
-------------                          ---------------------------              -------------------
signs key.use for model:nexus-primary
Key Authority decides (allow/ask/deny)
daily token budget checked
signs model.call  ───────────────────▶ checks signature + plan digest
                                       refuses unknown / quarantined agents
                                       refuses everything in lockdown
                                       per-agent daily budget
                                       holds the provider key ───────────────▶ DeepSeek, or a local
                                                                               llama.cpp server
                  ◀─────────────────── answer (never logged)  ◀───────────────
```

Agents ask for **NEXUS model names** only: `nexus-primary`, `nexus-coder`,
`nexus-fast`. Which open-weight model answers is set in
`config/control-plane.json` and can change without touching any agent.

## Run it (Termux)

```
npm run control-plane -- check      # which models are ready
npm run control-plane               # start it on 127.0.0.1:4100 (this device only)
npm run control-plane -- log        # recent events; checks the log chain
```

A provider key is read only from the environment of the Control Plane's own
process, for example `export NEXUS_KEY_DEEPSEEK=...` typed in Termux. Never put
a key in a file in this repository, and never paste one into a chat.

A backend whose key is not set is skipped. A keyless local backend (a
llama.cpp `llama-server` on `127.0.0.1:8080`) costs nothing to run.

## What it never does

- Never logs or stores a prompt, an answer or a key.
- Never listens beyond this device.
- Never retries after a timeout (the first call may already have cost money).
- Never answers while NEXUS is in lockdown or for a quarantined agent.

## Allowing model calls

Model calls are protected actions (`key.use` on `model:<name>`). With no rule
they are denied. To have the Founder approve each call, add a rule such as:

```json
{ "id": "models-ask", "actor": "genesis", "action": "key.use", "target": "model:*", "effect": "ask" }
```

`main.py` is the earlier Phase 1 Python skeleton and is left as it was.
