# Open a deck in T3

The desktop toolbar has Open with T3 Local and Open with T3 Remote, also in
More when the window is narrow. Local opens the actual deck folder or offline
mirror in the installed `~/.local/bin/t3 app` CLI. T3 must already be running.
No prompt is sent and no model starts automatically.

Remote opens the configured existing T3 thread for the server deck. That thread's
agent runs on its remote machine, independently of this desktop app. T3's
linked-environment agent tools are not required; the T3 client needs its usual
connection to the remote environment.

Configure known deck threads in `t3-workspaces.json` inside DeckWerk's user-data
directory. It is an array of objects with `server` (exact server origin),
`deckId` (server folder id), `environmentId`, and `threadId`. A missing mapping
reports an error rather than opening another deck's agent. The mapping is local
configuration and contains no credentials. Existing T3 authentication applies.

Both launchers flush the current deck first. A local agent works in the Mac's
mirror and can keep editing offline. A remote agent works against the server's
live deck through slide-agent, while every connected editor sees its changes.
Avoid having both agents edit the same slide at once.
