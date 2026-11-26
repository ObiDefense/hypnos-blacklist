// Runs in GitHub Actions when a mod labels an issue (see ../workflows/blacklist.yml).
//   approved  on a submission       → player added to / updated in blacklist.json, issue closed
//   approved  on a removal request  → player removed
//   remove                          → player removed
//   denied                          → issue closed, nothing changes
//   weekly / "Run workflow"         → names of listed UUIDs updated after name changes
// Issue text is untrusted: it is only parsed as data, never put into a shell command.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LIST = path.join(process.cwd(), 'blacklist.json');
const TAGS = {
  'blatant cheater': 'blatant_cheater', 'closet cheater': 'closet_cheater', 'confirmed cheater': 'confirmed_cheater',
  sniper: 'sniper', 'possible sniper': 'possible_sniper', 'legit sniper': 'legit_sniper',
  caution: 'caution', account: 'account', info: 'info',
};
const NAME = /^\w{1,16}$/;
const UUID = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

/** Dashed lower-case UUID from the form, or null. */
function readUuid(form) {
  const m = UUID.exec(String(form.UUID || '').trim());
  return m ? m.slice(1).join('-').toLowerCase() : null;
}

// ------------------------------------------------------------------------------------------- parsing

/** Issue-form body ("### Label\n\nvalue") → { label: value }. */
function parseForm(body) {
  const out = {};
  const parts = String(body || '').split(/^### +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const label = (nl < 0 ? part : part.slice(0, nl)).trim();
    let value = nl < 0 ? '' : part.slice(nl + 1).trim();
    if (value === '_No response_') value = '';
    out[label] = value;
  }
  return out;
}

/** Untrusted text: no Minecraft formatting codes, no control characters, bounded length. */
function clip(text, max) {
  text = String(text == null ? '' : text).replace(/\u00a7[\s\S]?/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

const LINK = /^https?:\/\/[^\s"<>]+$/i;

/** The submission in an issue, or { error }. */
function readSubmission(issue) {
  const form = parseForm(issue.body);
  const name = clip(form['Minecraft name'], 32).replace(/^@/, '');
  // shown in a bot comment: inside a code span, so it can't @mention anyone or inject links
  if (!NAME.test(name)) return { error: `\`${clip(name, 32).replace(/`/g, '')}\` is not a valid Minecraft name.` };
  const tag = TAGS[String(form.Tag || '').trim().toLowerCase()] || 'blatant_cheater';
  const reason = clip(form.Reason, 200);
  if (!reason) return { error: 'The reason is empty.' };
  const evidence = String(form.Evidence || '').split(/\r?\n/).map((l) => clip(l.replace(/^[-*•]\s*/, ''), 300))
    .filter(Boolean).slice(0, 10);
  if (!evidence.some((e) => LINK.test(e))) return { error: 'The evidence needs at least one link (https://…) to a video or screenshot.' };
  return { name, uuid: readUuid(form), tag, reason, evidence, notes: clip(form.Notes, 500) };
}

function readName(issue) {
  const name = clip(parseForm(issue.body)['Minecraft name'], 32).replace(/^@/, '');
  return NAME.test(name) ? name : null;
}

// ------------------------------------------------------------------------------------------- list

function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LIST, 'utf8'));
  } catch {
    data = {};
  }
  if (Array.isArray(data)) data = { entries: data };
  if (!Array.isArray(data.entries)) data.entries = [];
  data.version = 1;
  return data;
}

function save(data) {
  data.updated = Date.now();
  data.entries.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
  fs.writeFileSync(LIST, `${JSON.stringify(data, null, 2)}\n`);
}

function findEntry(data, uuid, name) {
  const lower = String(name || '').toLowerCase();
  return data.entries.find((e) => uuid && e.uuid && e.uuid.toLowerCase() === uuid.toLowerCase())
    || data.entries.find((e) => String(e.name).toLowerCase() === lower)
    || data.entries.find((e) => (e.pastNames || []).some((n) => String(n).toLowerCase() === lower));
}

/** Old name → pastNames (max 10), new name in. */
function rename(entry, name) {
  if (!name || name === entry.name) return false;
  const past = (entry.pastNames || []).filter((n) => n.toLowerCase() !== name.toLowerCase() && n.toLowerCase() !== String(entry.name).toLowerCase());
  if (entry.name && entry.name.toLowerCase() !== name.toLowerCase()) past.push(entry.name);
  entry.pastNames = past.slice(-10);
  entry.name = name;
  return true;
}

/** Adds or updates; keeps the original added date / submitter and merges evidence. */
function upsert(data, entry) {
  const now = Date.now();
  const existing = findEntry(data, entry.uuid, entry.name);
  if (existing) {
    rename(existing, entry.name);
    Object.assign(existing, {
      uuid: entry.uuid || existing.uuid || null,
      reason: entry.reason,
      tag: entry.tag,
      notes: entry.notes || existing.notes || '',
      evidence: [...new Set([...(existing.evidence || []), ...entry.evidence])],
      approvedBy: entry.approvedBy,
      issue: entry.issue,
      updatedAt: now,
    });
    return { entry: existing, updated: true };
  }
  const fresh = {
    uuid: entry.uuid || null,
    name: entry.name,
    reason: entry.reason,
    tag: entry.tag,
    evidence: entry.evidence,
    notes: entry.notes || '',
    addedBy: entry.addedBy,
    approvedBy: entry.approvedBy,
    issue: entry.issue,
    addedAt: now,
    updatedAt: now,
  };
  data.entries.push(fresh);
  return { entry: fresh, updated: false };
}

function remove(data, name, uuid) {
  const e = findEntry(data, uuid, name);
  if (!e) return null;
  data.entries = data.entries.filter((x) => x !== e);
  return e;
}

// ------------------------------------------------------------------------------------------- GitHub

async function api(method, route, body) {
  const res = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function lookupPlayer(name) {
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    if (res.status !== 200) return null;
    const { id, name: real } = await res.json();
    return { uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`, name: real };
  } catch {
    return null;
  }
}

/** UUID → { uuid, name } (current name), null if Mojang doesn't know it. */
async function profileOf(uuid) {
  try {
    const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`);
    if (res.status !== 200) return null;
    const { name } = await res.json();
    return NAME.test(name) ? { uuid, name } : null;
  } catch {
    return null;
  }
}

/** Weekly: every listed UUID gets its current name (old names stay matchable through pastNames). */
async function refreshNames() {
  const data = load();
  const changes = [];
  for (const e of data.entries) {
    if (!e.uuid) continue;
    const p = await profileOf(e.uuid);
    if (p && p.name !== e.name) {
      changes.push(`${e.name} → ${p.name}`);
      rename(e, p.name);
    }
    await new Promise((r) => setTimeout(r, 250)); // stay well under Mojang's rate limit
  }
  if (!changes.length) {
    console.log('No name changes');
    return;
  }
  save(data);
  commit(`Name changes: ${changes.join(', ').slice(0, 200)}`);
  console.log(changes.join('\n'));
}

function git(...args) {
  return execFileSync('git', args, { stdio: 'pipe' }).toString();
}

/** Commits blacklist.json if it changed; retries on a concurrent push. */
function commit(message) {
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('add', 'blacklist.json');
  try {
    git('diff', '--cached', '--quiet');
    return false; // nothing changed
  } catch {
    // there are changes
  }
  git('commit', '-m', message);
  for (let i = 0; i < 3; i++) {
    try {
      git('push');
      return true;
    } catch (err) {
      if (i === 2) throw err;
      git('pull', '--rebase');
    }
  }
  return true;
}

// ------------------------------------------------------------------------------------------- main

async function main() {
  if (process.env.GITHUB_EVENT_NAME === 'schedule' || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    await refreshNames(); // nothing from issues is read here
    return;
  }
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  const issue = event.issue;
  const label = event.label.name;
  const mod = event.sender.login;
  const say = (text) => api('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body: text });
  const close = (reason) => api('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: reason });

  // labels already need Triage access; check again so a misconfigured repo can't be abused
  const perm = await api('GET', `/repos/${repo}/collaborators/${encodeURIComponent(mod)}/permission`);
  const role = perm.role_name || perm.permission;
  if (!['admin', 'maintain', 'write', 'triage'].includes(role)) {
    console.log(`${mod} (${role}) may not review, ignoring`);
    return;
  }

  // which form made the issue, from its fields (the forms' own labels only exist if someone created them)
  const form = parseForm(issue.body);
  const isRemoval = 'Why should they be removed?' in form && 'Minecraft name' in form;
  const isSubmission = 'Minecraft name' in form && 'Reason' in form && 'Evidence' in form;

  if (label === 'denied') {
    await say(`Denied by @${mod}.`);
    await close('not_planned');
    return;
  }

  if (label === 'remove' || (label === 'approved' && isRemoval)) {
    const name = readName(issue);
    const uuid = readUuid(form);
    if (!name && !uuid) {
      await say('I could not find a valid Minecraft name or UUID in this issue.');
      return;
    }
    const data = load();
    const removed = remove(data, name, uuid);
    if (!removed) {
      await say(`\`${name || uuid}\` is not on the blacklist.`);
      await close('completed');
      return;
    }
    save(data);
    commit(`Remove ${removed.name} (#${issue.number}, by ${mod})`);
    await say(`Removed \`${removed.name}\` from the blacklist (by @${mod}).`);
    await close('completed');
    return;
  }

  // approved submission: only issues made with the "Submit a player" form
  if (!isSubmission) {
    await say('`approved` only works on issues made with the *Submit a player* form.');
    return;
  }
  const sub = readSubmission(issue);
  if (sub.error) {
    await say(`Can't add this: ${sub.error} Edit the issue, then remove and re-add the \`approved\` label.`);
    return;
  }
  // the UUID (sent by Hypnos) identifies the account even after a name change; else look the name up
  const byUuid = sub.uuid ? await profileOf(sub.uuid) : null;
  const player = byUuid || await lookupPlayer(sub.name);
  const renamedNote = byUuid && byUuid.name.toLowerCase() !== sub.name.toLowerCase()
    ? `\n\nThat UUID belongs to \`${byUuid.name}\` now (submitted as \`${sub.name}\`).` : '';
  const data = load();
  const result = upsert(data, {
    ...sub,
    uuid: player ? player.uuid : null,
    name: player ? player.name : sub.name,
    addedBy: issue.user.login,
    approvedBy: mod,
    issue: issue.number,
  });
  save(data);
  commit(`${result.updated ? 'Update' : 'Add'} ${result.entry.name} (#${issue.number}, approved by ${mod})`);
  await say(`${result.updated ? 'Updated' : 'Added'} \`${result.entry.name}\` (${sub.tag.replace(/_/g, ' ')}) – approved by @${mod}.`
    + `${player ? '' : '\n\nNo Mojang account with that name was found (nick?), so Hypnos matches it by name.'}`
    + renamedNote
    + '\n\nHypnos clients pick it up within a few minutes.');
  await close('completed');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseForm, readSubmission, readName, readUuid, upsert, remove, findEntry, rename };
