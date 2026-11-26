# Hypnos shared blacklist

`blacklist.json` is the shared blacklist every Hypnos client reads. Nobody edits it by hand: entries
are added through reviewed issues.

- **Suggest a player**: in Hypnos, select them in your blacklist → *Submit to shared* (or `/bl submit <name>`),
  or open [a new issue](../../issues/new/choose) → *Submit a player*. Evidence is required.
- **Wrongly listed?** Open *Request removal* (or `/bl removal <name>` in Hypnos).

## For mods

Review the issue, then add a label:

| label | on | result |
|---|---|---|
| `approved` | Submit a player | added to (or updated in) the list, issue closed |
| `approved` | Request removal | player removed, issue closed |
| `denied` | anything | issue closed, nothing changes |
| `remove` | anything | player removed, issue closed |

Only people with **Triage** access or more can add labels (and the workflow checks that again).
Every change is a commit in this repository, so it can be reverted.

Entries are tied to the player's UUID (Hypnos fills it into the forms). Every Monday the workflow
updates the names of listed players who changed their name; old names are kept in `pastNames`.
To run that now: Actions → Blacklist → *Run workflow*.
