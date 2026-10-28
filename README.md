# Foster First Night

A child is placed with you tonight. The caseworker could only tell you an age, a city and maybe one favorite show. Foster First Night turns that into a small, kind plan for the first evening: what to put on, what to play, what to eat, and a few things you can say that never touch family or the past.

- Live demo: https://foster-first-night.lumegridai.workers.dev
- MCP server: `https://foster-first-night.lumegridai.workers.dev/mcp`
- Built for the Qloo Agentic Hackathon. Taste data comes from the Qloo hackathon API. The planning agent runs on Gemini (`gemini-3.1-flash-lite`).

## What it does

You enter an age, a foster city and a few favorites (shows, films, artists, games, foods). Optional: things to avoid, and where the child is from (used as a hint only, and only for ages 10 and up).

A planning agent then works through tools, and you can watch each step:

1. `resolve_favorite` finds each favorite in Qloo (show, film, game, book, podcast, artist or food).
2. `set_avoid_terms` records the triggers you listed.
3. `qloo_suggest` asks Qloo for shows, films and music that sit close to those favorites, filtered by content rating for the child's age, with Qloo's explainability scores ("Qloo ties it to Bluey and Peppa Pig").
4. `search_food_tags` and `qloo_nearby_food` find restaurants around the foster home that match a favorite dish or cuisine.
5. `finish_plan` submits the plan.

Every result is checked in code before it reaches the page. Anything held back is listed with the reason. If you tap "This scared them" on a card, the plan reruns and items similar to it are held back too. If the child's favorites are few, the page shows a "Let them choose" board instead of guessing.

If the agent is off, over its daily budget, or fails, a built-in planner using the same Qloo calls and the same safety layer answers instead, and the page says so.

## The safety layer (plain code, not a prompt)

The model can write notes, openers and a loose run of the evening. It cannot decide what is safe. `src/safety.js` does that, on every item, after any model output:

- **Privacy.** Names, phone numbers, emails, addresses, case numbers and dates of birth are removed from the input before anything is sent anywhere.
- **Ratings by age.** TV: ages 2 to 6 get TV-Y and TV-G; 7 to 9 add TV-Y7; 10 to 13 add TV-PG; 14 and up add TV-14. Films: G up to 6, G and PG up to 12, PG-13 from 13. Unrated video is held back under 13. Music has no rating in Qloo, so under 10 it is limited to artists Qloo tags as children's music, and the card says to preview songs.
- **Triggers.** Each trigger is expanded (dog also covers puppy, hound, and so on) and matched against themes, genres and summaries.
- **First-night themes.** Family separation, orphans, foster care, adoption, abandonment, prison and similar themes are held back by default, along with horror and murder plots, whatever the rating says.
- **Marked triggers.** Items that share themes with something you marked are held back.
- **Places.** Bars, breweries, lounges and grocery stores are not offered as a place to get a meal.
- **Model text.** Anything the model writes is rejected if it brings up family, the removal, trauma, a trigger word, an em dash, or claims the home already has food or items. The agent gets one chance to fix it.

## MCP server

`POST /mcp` speaks MCP over Streamable HTTP (stateless JSON-RPC; protocol versions 2025-06-18, 2025-03-26, 2024-11-05). Tools:

| Tool | What it does |
| --- | --- |
| `plan_first_night` | Full plan from age, favorites, triggers, hometown and foster city |
| `suggest` | Age-screened shows, films or music seeded by favorites |
| `nearby_food` | Restaurants near a city for a dish or cuisine, with an honest match level |
| `check_item` | Check one title or artist against the safety rules for a child |

Any desktop MCP client that launches stdio servers:

```json
{
  "mcpServers": {
    "foster-first-night": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://foster-first-night.lumegridai.workers.dev/mcp"]
    }
  }
}
```

Clients with native Streamable HTTP support can use the URL directly. Quick check:

```bash
curl -s https://foster-first-night.lumegridai.workers.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_item","arguments":{"age":10,"name":"Lady and the Tramp","kind":"film","triggers":"dogs"}}}'
```

## HTTP API

- `GET /api/meta` shows mode, model and tool names.
- `POST /api/plan` returns the planner's answer as JSON.
- `POST /api/agent` streams the agent as NDJSON (`step` lines, then one `result` line).

## Privacy

Nothing about a child is stored. There is no database for plans, request bodies are not logged by the app, and the page writes nothing to localStorage. The only thing kept is a number: a Workers KV counter of how many agent runs happened today, used as a budget cap. Please do not type a real child's name or details. Use the examples to try it.

## Honest limits

- Qloo place data says a restaurant matches a cuisine or tag. It does not confirm a restaurant serves a dish. Where only the cuisine matched, the card says "cuisine match, not confirmed".
- Qloo music has no age rating. Preview songs before playing them.
- A hometown hint is a hint. The page shows it apart from the child's own favorites and tells you to ask first.
- This is a conversation starter, not casework. It does not replace the child's own choices or a caseworker.
- Agent runs are capped per day and per IP. When the cap is reached the built-in planner answers.

## Run it yourself

```bash
npm install
npm test                                  # 32 tests, synthetic fixtures, no network
npx wrangler secret put QLOO_API_KEY      # Qloo hackathon key
npx wrangler secret put GEMINI_API_KEY    # optional; without it the built-in planner answers
npx wrangler kv namespace create foster-first-night-budget   # then put its id in wrangler.toml
npx wrangler deploy
```

For local runs put `QLOO_API_KEY` and `GEMINI_API_KEY` in `.dev.vars` and run `npx wrangler dev`.

## Layout

```
src/worker.js   routes, rate limit, daily cap, NDJSON stream
src/agent.js    tools, system prompt, agent loop, plan assembly
src/gemini.js   Gemini function-calling client
src/engine.js   Qloo-backed planner pieces (suggest, food, openers)
src/qloo.js     Qloo hackathon API client
src/safety.js   privacy screen, ratings, triggers, themes, text guard
src/mcp.js      MCP server
public/         the web app
test/           unit tests
```

## Credits and license

Taste data and explainability from [Qloo](https://www.qloo.com/). Planning agent on Google Gemini. MIT License, see `LICENSE`.
