## read-too-large
File too large ({{size}} bytes; limit {{max}}). Use run_shell or read it in segments first.

## read-lines-suffix
… {{total}} lines total

## write-ok
Written to {{path}} ({{length}} characters)

## edit-ambiguous
oldText appears {{count}} times; provide a more precise snippet or set replaceAll.

## edit-ok
Updated {{path}} (replaced {{count}} occurrences)

## shell-failed
Command failed: {{message}}{{spillBlock}}

## shell-failed-spill
Full output: {{spillPath}}

## shell-exit
Exit code {{exitCode}}{{spillBlock}}

## shell-exit-spill
Full output written to {{spillPath}}

## skill-directory
Skill directory: {{directory}}
Use relative paths to access companion files within that directory.

## skill-truncated
… truncated

## skill-missing
No skill named {{name}}. Bound skills: {{bound}}.

## send-message-ok
Sent to {{name}}; work {{workId}} has started. The other employee's reply will appear in your direct messages.

## send-channel-ok
Message sent to channel "{{roomName}}"; {{count}} employees were woken for this task, and their replies will appear in that channel.

## send-channel-nobody
Message sent to channel "{{roomName}}"; no one was addressed, so no employees were started.

## invite-ok
Invited {{names}} to the current channel ({{count}} added); invitations do not wake them. Mention them again if you need a reply.

## invite-replay
This invitation has already been applied (safe replay; no duplicate invitation).

## note-list
Shared notes (work version {{version}}, {{count}} entries):
{{items}}

## note-saved
Note saved: {{title}} (id={{noteId}}, work version {{version}}).

## send-mail-ok
Email sent to {{name}}; work {{workId}} has started.

## delegate-ok
Task delegated to {{name}} (work {{workId}}). The result will appear in this conversation as a message; you can continue with other work or wait.
