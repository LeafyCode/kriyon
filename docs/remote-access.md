# Remote access

Watch and type into your Kriyon sessions from your phone, or from another computer. This page
is for people using Kriyon. Words in quotes are what the app shows.

## What it does, and what it doesn't

- **It shows your sessions where you are.** A paired phone or computer sees each session's
  status, reads the conversation, and shows the live terminal. A Controller can also type,
  answer Claude's questions and start new sessions.
- **Your sessions stay on your computer.** Claude runs there, as it always does. Kriyon has no
  copy of your sessions anywhere else, and the devices talk to each other end to end
  encrypted.
- **Your computer has to be on, with Kriyon open.** A computer that's asleep or shut can't be
  reached; the phone shows it as reconnecting until it's back.
- **It's off until you turn it on,** and only devices you pair can connect.

## Turning it on

On the computer: **Settings › Remote access**, then the **Remote access** switch. Kriyon asks
first, under "Turn on remote access?":

- "Devices you pair can see your sessions, and Controllers can type into them."
- "A Controller can do anything you can do in a terminal: full shell access as you."
- "A Viewer sees every session's screen, including any secret printed there."
- "This computer starts accepting connections, from paired devices only."
- "Devices reach this computer directly, on the same network or through your own Tailscale.
  Everything between them is end-to-end encrypted."
- "A paired phone that's lost or stolen can still reach your sessions until you remove it
  here."

Press **Turn on** only if that's what you want. The switch then says "On: devices you paired
can reach this computer." Turn it off at any time: "Off: this computer accepts no
connections."

## Viewer or Controller

You choose a role for each device when you pair it, and you can change it later under
**Paired devices**.

- **Viewer:** "A Viewer sees every session's screen, including any secret printed there, but
  can't type."
- **Controller:** "A Controller can do anything you can do in a terminal: full shell access as
  you."

Give a phone the Controller role only if you'd let it type in your terminal.

## Pairing a phone

1. On the computer, under **Pair a device**, choose **Viewer** or **Controller**, then press
   **Pair a device**. A QR code shows, with a countdown.
2. In the Kriyon app on the phone, press **+** (Pair a computer), then **Scan the QR code**.
   If you can't scan, press **Copy pairing code** on the computer, get the code to the phone,
   and paste it into "Or paste the pairing code", then **Connect**.
3. The phone shows six digits: "Type this code on the computer". It also shows the "Role on
   this computer" and "Code expires in".
4. The computer shows "Type the six-digit code it shows." Type the digits, then **Confirm
   code**. The computer says "… is paired." and the phone says "Paired with …".

A wrong code tells you how many tries are left. After too many, or after the QR code runs
out, start again with **Pair a device**.

## Pairing another computer

To use computer B's sessions from computer A:

1. On **B**: **Settings › Remote access**, turn it on, and under **Pair a device** choose a
   role and press **Pair a device**. Press **Copy pairing code**.
2. On **A**: **Settings › Remote access › Use another computer from here**. Paste the code
   and press **Connect**.
3. A shows "Type this code on the other computer: …". Type it on B and press **Confirm code**.
4. A says "Paired with …. Its sessions are under Other computers in the sidebar."

## The three ways to connect

Kriyon picks the best way that works, by itself.

1. **The same network.** Both devices on the same Wi-Fi or office network. Free, direct.
2. **Your own Tailscale.** Both devices on your Tailscale network reach each other from
   anywhere, directly: "Devices on the same Tailscale network reach this computer from
   anywhere, directly." Free.
   - Remote access listens on one fixed UDP port, 49731 unless you change it under **Port**.
     "Devices paired before a change reach this computer only through our relay until you
     pair them again."
   - The line "Reachable over: …" lists the ways that work now.
3. **Our relay (paid).** For when no direct path works, for example a phone on mobile data
   without Tailscale. "Through our relay, traffic passes a server that can't read it. It only
   joins devices signed in to the same relay account."
   - On the computer, under **Our relay (paid)**, press **Sign in**. Your browser opens; check
     it shows the code Kriyon shows, then approve.
   - Press **Subscribe** to buy a subscription on the website. Later it's **Manage
     subscription**.
   - On the phone: **Settings › Reach from anywhere › Sign in**. "Subscriptions are managed
     on your computer. Sign in with the same account there."
   - Sign in with the **same account** on every device: "our relay only joins devices of one
     account." An account can have up to 10 devices on the relay.
   - Turn the relay on or off with its switch. Off: "devices reach this computer directly
     only."

## Using it on your phone

**Home** lists each paired computer and its sessions. At the top, how many sessions there are
and how many need you; the chips show **All**, **Needs you** or **Running**.

- **Status words:** "Asking" (Claude asked a question), "Your turn" (Claude finished and
  waits for you), "Running", "Idle", or "Unknown" when the computer can't tell.
- **Needs you:** each question shows with its first options and **Answer in the terminal**.
  A finished turn shows its summary, the files it changed, and **Reply**.
- **Each computer's line** says how it's linked, for example "Connected · direct ·
  Controller", "Connected · through the relay", or "Reconnecting · last seen 3m ago".

Open a session to see it as **Readable** or **Terminal**:

- **Readable** is the conversation at phone width: what you asked, Claude's replies, each step
  it took. It needs the Kriyon Companion on in that session; without it, the session shows as
  its terminal.
- **Terminal** is the real terminal, as on the computer.

### Answering Claude's questions

Questions are answered in the terminal, with their options as Claude Code shows them. Press
**Answer in the terminal**, take control, and type your answer. While a question shows,
"Typing is off while Claude asks. Answer in the terminal."

### Typing

- In the terminal, a Controller presses **Take control**. "You have control. Type below." Type
  in the field and press Enter; the key row adds esc, tab, ctrl and the arrows.
- In Readable, with control, write to Claude in "Message Claude…".
- **Give back** returns control to the computer. Typing on the computer takes control back at
  once.
- If you typed on the computer in the last few seconds, the computer shows "… wants to type"
  instead, with **Let … type** and **Not now**.
- A Viewer sees "This phone may only watch."

### New session

A Controller can start a session: **New** beside the computer's name. Choose a project and,
if you like, a title ("Named after the project if left empty"), then **Start session**.
"Claude starts in the project folder on the computer. Worktree setup stays on the computer."

## Using it from another computer

The paired computer's sessions are under **Other computers** in the sidebar. Choose a session
and show it as **Terminal** or **Readable**. A Controller can **Take control** to type, and
start one with **New session**. Questions are answered in the terminal, as on the phone.

## Alerts

The phone can tell you when a session needs you. The alert says only "A session needs you".
"Details come from your computer." Open Kriyon to see which session.

- Turn alerts on or off in **Settings › Alerts** on the phone.
- If it says "Not allowed", allow notifications for Kriyon in the phone's own settings.
- Alerts arrive even while the app lock is on: they carry nothing of a session.

## The app lock

A Controller phone can type into your computer's terminal, so Kriyon asks for Face ID, Touch
ID, the fingerprint or the phone's passcode before it shows any session: "Kriyon is locked"
until you unlock it.

- It's on by default once any computer made the phone a Controller. You can turn it on for a
  Viewer-only phone, or off, in **Settings › App lock**: "Ask before showing sessions".
- **Lock again when away:** Immediately, 1 min, 5 min (the default) or 15 min.
- While locked, and in the phone's app switcher, Kriyon shows a plain cover, never a session.
- If the phone has no passcode or biometrics, Kriyon says so ("This phone has no passcode,
  Face ID or fingerprint set up, so Kriyon can't lock itself.") and lets you **Continue**. Set
  a passcode on the phone to use the lock.

## A lost or stolen phone

Remove it **on the computer**: **Settings › Remote access › Paired devices**, then **Remove**
beside it. "… is cut off at once and forgotten. To use it again, pair it again." Do this on
every computer the phone was paired with.

**Forget** on the phone only stops that phone: "Forgetting here stops this phone. To cut a
lost phone off, remove it on the computer."

If the phone used our relay, you can also remove it from the relay account (**Devices on the
relay account**, **Remove**). That only stops its relay use: "It stays paired: same Wi-Fi and
Tailscale links keep working until you unpair it." To cut it off, remove it under **Paired
devices**.

## What is kept, and where

- **On your computer and your phone only:** your sessions and code, each device's key, the
  list of paired devices, your relay sign-in if you use our relay, and, on the computer, each
  phone's sealed push token for alerts.
- **Our relay's operator, BisBig (India), only if you subscribe:** your email, your devices'
  keys, the date you've paid until, daily usage, and any ban.
- **The payment provider:** your card details. We never see them.
- **Never kept:** your IP addresses and your phones' push tokens. The alert sender opens a
  sealed token in memory, sends the one alert, and keeps nothing.
- **Through the relay,** your traffic passes a server that can't read it.

## Troubleshooting

- **macOS asks whether Kriyon may accept incoming network connections.** Allow it. Remote
  access can't be reached on the network or Tailscale without it.
- **"Port … is in use by another program".** Remote access uses another port for now. Free
  the port, then turn remote access off and on, or reopen Kriyon. Devices paired over the
  network or Tailscale may not reach the computer until then.
- **"Reconnecting" on the phone, or "Disconnected, reconnecting. Typing is off." on a
  computer.** The other end went away: asleep, shut, Kriyon closed, or the network dropped.
  It reconnects by itself; nothing you typed while it was away is sent.
- **"Removed from that computer · pair again to use it".** The computer removed this device.
  Pair it again if you want it back.
- **"This phone may only watch."** It was paired as a Viewer. Change its role on the computer
  under **Paired devices**.
- **The camera is off for Kriyon.** Turn it on in the phone's settings, or paste the pairing
  code instead.
- **Our relay says:**
  - "Sign in again": the sign-in ran out. Sign in again on that device.
  - "Our relay needs a subscription": subscribe on the computer with **Subscribe**.
  - "Relay access is suspended for this account": the account is blocked from the relay.
  - "This device was removed from your relay account": sign in on it again to add it back.
  - "You already use 10 devices. Remove one first": remove one under **Devices on the relay
    account**.
  - "Too many devices are connected through our relay. Kriyon tries again later": nothing to
    do, it retries.
  - "Can't reach our relay's service. Try again later": the service is down or out of reach.
  - "Our relay refused this computer's pass, and a new pass won't help. Please report this":
    tell us.
