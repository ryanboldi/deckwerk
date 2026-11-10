# Open a deck in T3

The desktop toolbar has Open with T3 Local and Open with T3 Remote, also in
More when the window is narrow. Both save the current deck, open T3, and copy
presentation context to the clipboard. Paste it into the conversation you want
to use, then describe your changes. Neither button registers a project, creates
a conversation, sends a message, or starts a model.

Local brings T3 forward and copies the actual deck folder or offline mirror.
Use a conversation running on this Mac. That agent can keep editing offline.

Remote opens an existing conversation if one is configured for this exact
presentation. Otherwise it brings T3 forward. Its copied context identifies the
server, presentation, and web editor link. Choose a conversation on the server
(RyBox for RyBox presentations) and paste the context before asking for edits.
Bringing T3 forward alone does not change which machine a conversation runs on.
New decks and forks work without setting up a mapping.

Optional existing-conversation links live in `t3-workspaces.json` inside
DeckWerk's user-data directory. The file is an array of objects with `server`
(exact server origin), `deckId` (server folder id), `environmentId`, and
`threadId`. Missing or unreadable configuration falls back to opening T3.
Invalid identifiers in a matching entry report an error. The file contains no
credentials; T3 uses its existing connections and authentication. Linked
environments in Labs are not required to use these buttons.

The copied context asks agents to read the presentation instructions and make
version checkpoints before and after editing. A remote agent works on the
server's live deck through slide-agent while connected editors see its changes.
Avoid having local and remote agents edit the same slide at once.
