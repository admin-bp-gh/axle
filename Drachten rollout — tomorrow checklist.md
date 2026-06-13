# Drachten rollout — tomorrow checklist

Almost everything is already done and live-verified (last night, 2026-06-11). Tomorrow at
Drachten is just three things: Tailscale, register the user, hand over.

## Already done last night ✅

- Code deployed (merged 9-file set — also cleared the two queued bugfix rounds; db.js migration ran clean).
- `MAILBOX_DRACHTEN` confirmed; scheduled task + manual Sync now cover info@ **and** drachten@.
- Queue seeded unread-only: **#70 (Karla Kules)** is a real ready-to-send item waiting for the team.
- drachten@ **Send** re-tested end-to-end (admin@→drachten@→reply delivered) — the old Gate-4 carry is closed. #71 is that test item, already Done.

---

## Tomorrow at Drachten

### 1. Tailscale on the Drachten desktop
Install Tailscale, sign in, add the device to the **@budget-parts.nl** tailnet. Decide which
login the shared desktop uses — you'll read the exact value off the screen in the next step, no
need to write it down.

### 2. Register the "Drachten" user
On the Drachten desktop, open **https://axle-box.tail58a804.ts.net**. You'll get a
**"Not registered"** page that prints the exact tailnet identity. Copy that login string.

On the box (PowerShell), paste it where shown:
```
cd C:\Axle\app
node -e "const {db}=require('./db.js'); db.prepare('INSERT OR IGNORE INTO users (tailscale_login, display_name, role) VALUES (?,?,?)').run('PASTE_LOGIN_HERE','Drachten','sales'); console.log(db.prepare('SELECT tailscale_login, display_name, role FROM users').all());"
```
Refresh the browser — the 403 is gone and the Drachten queue loads (currently #70).

> One shared "Drachten" user sees exactly the Drachten queue (routing labels all drachten@ mail
> owner "Drachten"). If you'd rather put Rob and Huub on separate logins, add one row each with
> their name as display_name **and** `owner_label = 'Drachten'`.

### 3. Hand over to Rob & Huub
- They open the tool on the Drachten desktop; **NL** toggle (top-right) if they prefer Dutch.
- Open #70, confirm the brief + draft read well, and let them send their first real reply with review.
- That's it — new drachten@ mail now flows in automatically every 15 minutes.

---

## Rollback (if ever needed)
- Remove the user: `node -e "require('./db.js').db.prepare('DELETE FROM users WHERE display_name=?').run('Drachten')"`
- Items are just rows — archive in the UI.
