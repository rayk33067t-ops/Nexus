# Agent identity, Founder authorization, and their limits

## What this protects

- **Identity comes from a signature, never a name.** Each agent has its own
  Ed25519 credential, issued by the Founder with
  `npm run warden -- issue <agent>`. Key Authority keeps only the SHA-256
  fingerprint of each agent's public key. Every request is signed; Key
  Authority works out who sent it from the matching credential. A request that
  names its own actor is refused.
- **Refused:** unsigned requests, unknown keys, wrong keys, damaged or changed
  signatures, revoked or expired credentials, replayed requests (each nonce
  works once) and requests signed more than 5 minutes from now.
- **"founder" is reserved.** No credential can carry that name. Founder powers
  exist only through the Founder CLIs, and only with the passphrase.
- **Every privileged Founder operation checks the passphrase itself:** approve,
  reject, release, trust, pin, clear lockdown, reset the log, issue and revoke
  credentials, and change the passphrase. Calling the operation directly
  without it fails and changes nothing. Lockdown can only be cleared through the
  Warden. An agent's status can only be made less strict with a single-use proof
  that the passphrase was checked.
- **Refusals are recorded** in the Warden's hash-chained event log, without keys,
  signatures or passphrases. A refused request is attributed to an agent only
  when its signature proves which credential was used.

- **Rules and state live with the code.** Key Authority reads
  `config/key-authority.json` and keeps its state in `.nexus`, both inside the
  NEXUS folder itself, whichever folder NEXUS is started from. Genesis and both
  Founder CLIs refuse to start if `NEXUS_ROOT`, `NEXUS_RULES_PATH` or
  `NEXUS_STATE_DIR` is set; those are for the test suite only. A rules file that
  is a link is refused.
- **Approvals are claimed, then checked.** Each approval is stored under the exact
  agent, action, target and plan it covers. Using one first moves it, atomically,
  to a name only that request knows; only then is it read and checked. Racing
  requests can't both use it, and approving the same plan for two agents gives
  two approvals.
- **Lockdown lives in the Warden's chained log.** Starting lockdown writes a
  "lockdown" event; only the Founder's `lockdown:clear` writes "lockdown-cleared".
  Deleting the lockdown file doesn't end it, and a log that can't be verified keeps
  NEXUS locked.
- **Protected writes check the decision themselves.** When the guard allows a
  build it hands back a one-time grant for exactly that plan, project and output
  folder, valid for 60 seconds. The writer refuses to touch the disk without one.

## The limit: one Termux user

Genesis and the Founder currently run as the **same Termux operating-system
user** on the same phone. Anything running as that user can read the agents'
key files, the passphrase hash, and Key Authority's state, and could change
them.

So credentials stop identity from being claimed by name, and make every request
attributable to a key. They **do not** give operating-system isolation, and they
do not stop hostile code already running as that user.

Stronger separation needs a real security boundary: agents running as a
different operating-system user, or in an isolated service with its own
storage. Ordinary Termux on a standard Android phone doesn't offer that kind of
multi-user separation the way a server does.

Other known limits:

- The environment variables can still redirect the library code when it's
  called from someone's own script; only the real entry points refuse them.
  That is hostile code running as the same user, covered by the limit above.
- Deleting the whole event log, its head and the lockdown file together resets
  lockdown, because the log then looks new and empty. Note the head printed by
  `npm run warden -- log` somewhere off the phone to detect that.
- Grants live in memory and are only as private as the process: code already
  running inside the NEXUS process could use one before the writer does.
- If the passphrase hash file is deleted, the next `warden -- init` can set a
  new passphrase without the old one. The Warden's code-integrity check and event
  log make that visible, but they can't prevent it.
- Anyone can trigger lockdown by sending a hostile report, even unsigned. That
  is deliberate: lockdown only makes NEXUS stricter, and only the Founder can end it.
