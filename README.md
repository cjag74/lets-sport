# 🏸🏀 Let's Sport!

**Let's Sport** brings your neighbours together to play. Ever booked a badminton court and ended up one player short? Or posted in three group chats and got nothing back but a couple of "maybes"? Let's Sport fixes that. Anyone can host a badminton or basketball game in seconds: pick the date, time and venue, and drop a Google Maps pin so nobody turns up at the wrong court. Neighbours tap "I'm in" to join, and everyone can see who's coming and how many spots are left. If plans change, one tap frees your spot for someone else. Every game shows a skill level, so beginners are as welcome as seasoned players, and it's free to use. Find your crew, book the court, and play together. Let's sport!

🎬 **[Watch the 70-second demo video](demo-video/demo.mp4)**

## Run it

Requires Node.js 22.5+ (uses the built-in `node:sqlite` database).

```bash
npm install
npm start
```

Then open http://localhost:3000

## Features
- Sign up / log in (passwords hashed with scrypt, sessions stored in the database, HttpOnly cookie)
- Host a game: sport, title, date, time, venue, max players, skill level, notes
- Join / leave games, with live "spots left" counter; games block new joins when full
- Hosts can cancel their games
- 🗺️ Google Maps location for the venue: paste a Google Maps share link (full or `maps.app.goo.gl` short link), or tap **Use my location**, or just type the venue name. Every game card has **Show map**, **Open in Google Maps** and **Directions**. No Google API key needed.
- Filter by sport, and by Upcoming / My games / Past
- Confetti, bouncy animations, colourful cards 🎉

## Project layout
| File | What it does |
|---|---|
| `server.js` | Express server + REST API (auth, activities, join/leave) |
| `db.js` | SQLite schema (`users`, `sessions`, `activities`, `interests`) |
| `public/` | Frontend: `index.html`, `styles.css`, `app.js` |
| `data/letssport.db` | Database file (created automatically on first run) |

To start fresh, stop the server and delete the `data/` folder.

## Adding another sport
Add it to `SPORTS` in `server.js`, the `CHECK` constraint in `db.js`, and the emoji/buttons in `public/`.
