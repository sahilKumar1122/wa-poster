# WA Poster

Post one saved message to many WhatsApp communities you run, from a small app on your own computer.

Pick a message, tick the communities, check the preview, and send. Site: https://sahilkumar1122.github.io/wa-poster/

## Read this first

WA Poster connects the way WhatsApp Web does, through the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys) library. Automating an ordinary account can break WhatsApp's terms, and **your number can be banned**. Use a number set aside for this, post only to communities you run, and read the [safety notes](https://sahilkumar1122.github.io/wa-poster/safety.html). Not affiliated with WhatsApp or Meta.

## Features

- Message library with CSV import and in-app editing
- Community picker, sorted by the date in the group name, sent in list order
- WhatsApp-style preview with formatting, links and image captions
- Image attachments (saved with a message or for one send)
- Random gap between groups (default 15 to 25 s) and optional per-group variation
- Dry run, scheduling, live per-group status, local send log
- Optional password login

## Run it

Needs Node.js 20 or newer.

```bash
git clone https://github.com/sahilKumar1122/wa-poster.git
cd wa-poster
npm install
npm start
```

Open http://localhost:3000, scan the QR code (WhatsApp, Linked devices, Link a device), then import your messages. Do a dry run, then a real send to one community, then the rest.

Options:

```bash
WA_POSTER_PASSWORD='a-long-password' npm start   # require a password
WA_POSTER_EMAIL='you@example.com' WA_POSTER_PASSWORD='a-long-password' npm start   # email + password
caffeinate -i npm start                          # macOS: stay awake for scheduled sends
```

## Host it on a server

For use away from your computer. Needs a small Linux server with Docker and ports 80 and 443 open. `<server-ip>.sslip.io` works as a domain with automatic HTTPS if you have none.

```bash
git clone https://github.com/sahilKumar1122/wa-poster.git && cd wa-poster
printf 'DOMAIN=203.0.113.10.sslip.io\nWA_POSTER_PASSWORD=a-long-password\nWA_POSTER_EMAIL=you@example.com\n' > .env
docker compose up -d --build
```

Open `https://<your domain>`, log in, and scan the QR code. The WhatsApp login and your data live in the `data` volume, so they survive restarts. The app refuses to listen publicly without `WA_POSTER_PASSWORD`, and 5 wrong logins from one address lock it out for 10 minutes. The server holds a full WhatsApp login, so use a long password and keep the server updated.

Environment: `HOST`, `PORT`, `DATA_DIR` (where `auth/` and your data go), `COOKIE_SECURE=1` (set by the compose file behind HTTPS).

## CSV format

First row names the columns. A `title` (or `name`) column is the label and a `message` (or `text`) column is the body. Until you add messages, four samples from `messages.example.json` are shown.

## Where data lives

| Path | What | Committed |
| --- | --- | --- |
| `auth/` | WhatsApp login. Full access to the linked account | never |
| `messages.json` | Your saved messages | no |
| `images/` | Attached images | no |
| `schedules.json` | Scheduled sends | no |
| `sent-log.jsonl` | Exact text each group received | no |

The server listens on `127.0.0.1` only.

## Notes

- In announcement-only groups the linked number must be an admin.
- A scheduled job more than 20 minutes late is marked missed and never sent.
- The landing site is in `docs/` and is served by GitHub Pages.

## License

MIT
