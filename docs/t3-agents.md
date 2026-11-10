# Open a deck in T3

The desktop toolbar has Open with T3 Local and Open with T3 Remote, also in
More when the window is narrow. Both save the presentation and open a T3 chat
with presentation context in the composer. Add your requested changes and press
Send. Opening the chat never sends a message or starts an agent.

Local opens a new draft under No project on this Mac. Its context names the
actual deck folder, including the offline mirror for a server presentation.

Remote opens a chat on the presentation server under T3's No project workspace.
The first click creates the chat; later clicks reopen it. Each presentation and
fork has its own chat, without adding a T3 project. T3 must already be connected
to that server in the desktop app. Linked environments in Labs are not required.

The context asks agents to read the presentation instructions, make version
checkpoints before and after edits, and preserve the existing visual style.
A remote agent works on the server's live deck through slide-agent while
connected editors see its changes. Avoid having local and remote agents edit
the same slide at once.

## Server setup

Set `DECKWERK_T3_HOME` to the server user's T3 directory, for example
`/home/ryan/.t3`, when starting the collaboration server. T3 must be running with
a default model configured. A sandboxed service needs write access to T3's
`userdata` directory so the T3 CLI can issue and revoke its scoped sessions.

The launcher discovers the running T3 version, uses that version's local CLI
and RPC API, and keeps credentials on the server. Sessions expire after two
minutes and are revoked when the request finishes. The HTTP endpoint requires
the presentation server's owner and the desktop bridge header. Other deck
collaborators cannot open the owner's T3 chats.

Chat IDs are stored under `.deckwerk-t3` in the presentations root. Keep that
directory in backups so the mapping survives a restore. The old desktop
`t3-workspaces.json` mapping is no longer used.
