# Emit

Emit is a local digital-employee collaboration workspace.

## Language

**MCP tool trust**:
An employee-specific human declaration that an MCP tool may run as read-only without automatic risk review. A tool-published read-only hint is not trust.

**Work**:
One employee's execution assigned through a channel message, direct message, mail, or delegation. A work may be queued before its employee begins processing.

**Cross-employee wake budget**:
The per-root-work allowance, set in collaboration settings, that limits how many times one work may wake a different employee through a message, mail, or delegation. A refused wake spends none of it.

**Chat composer**:
The channel or direct-message editor in which content is written and channel recipients are selected separately. A typed mention is content, not a recipient selection.

**Ordinary reply**:
The first message an employee sends with `send_message` into the channel its own work started from without addressing anyone. It is linked to that work, and the work's final text becomes its recorded answer instead of a second room message.

**Internal address**:
The address Emit gives the user or an employee — a local part plus the one fixed internal domain, unique inside the workspace and carrying no delivery outside it.
_Avoid_: handle, username, email address

**External address**:
An address stored in a mail envelope that belongs to no internal identity. It is kept exactly as written and wakes no one.
_Avoid_: external contact, recipient
