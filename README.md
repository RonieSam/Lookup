# Neo ID lookup

Paste Neo IDs, check each one, and see the matching student records. Admins can upload spreadsheets to add or update student details.

- **Lookup page (`/`)**: paste any text, even a whole schedule or email. Every word is checked on its own, and only words that are valid Neo IDs are looked up; times, dates and other words are dropped (the page just shows how many were ignored). Results show found and not-found IDs, and can be copied or downloaded as CSV. Click any column heading to sort by it, and click again to reverse; the copy and CSV buttons follow the order on screen.
- **Admin page (`/admin`)**: password-protected upload of `.xlsx` or `.csv` files (columns the database doesn't have yet, like Email, are created automatically), plus placements: which students were placed in which companies.

## The Neo ID rule

Exactly 8 characters in the pattern **letter, digit, letter, digit, letter, digit, letter, digit**, for example `A1B2C3D4`. Lower-case input is accepted and stored upper-case. The rule lives in `src/lib/neo.ts`, and the database also enforces it with a check constraint.

## Deploy for free (about 10 minutes)

You need a free [Neon](https://neon.tech) account (Postgres), a free [Vercel](https://vercel.com) account, and a GitHub account to connect them.

1. **Database.** In Neon, create a project and copy its connection string (it starts with `postgresql://`). No setup beyond that: the app creates its own tables on first use.
2. **Code.** Push this folder to a new GitHub repository.
3. **Vercel.** Choose *Add New → Project*, import the repository, and before deploying add three environment variables:

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | the Neon connection string |
   | `ADMIN_PASSWORD` | a long password only you know |
   | `SESSION_SECRET` | a random string, e.g. the output of `openssl rand -hex 32` |

4. **Deploy**, open `https://your-app.vercel.app/api/health` (it should say `"ok": true`), then go to `/admin`, sign in, and upload your spreadsheet.

### Deploying on Cloudflare Workers instead

The app also runs on Cloudflare Workers (for example through the `@opennextjs/cloudflare` adapter). It talks to the database through Neon's serverless driver, which uses WebSockets, so it needs no raw TCP sockets and no Node networking modules.

- Add the three settings above under *Workers → your Worker → Settings → Variables and Secrets*, or with `npx wrangler secret put DATABASE_URL` (and likewise for the other two). Settings only take effect after the next deploy.
- Open `/api/health` after deploying. It lists any setting that's missing and says whether the database connection works, without ever showing a value. A plain `500` from the site usually means one of these two is wrong.
- `DATABASE_URL` must be a **Neon** connection string. Other Postgres hosts won't work with this driver.

Free plans have usage limits and they change, so check the current limits for Neon and Vercel. This app stores a few megabytes for a few thousand students.

## Uploading details

- Students are matched on the **Neo ID column**. It's detected from the header ("Neo ID", "NeoID", …) or from the cell contents, and you can pick a different column.
- **New columns are created automatically.** Upload a sheet with an `Email` column and every matched student gets an email; students without one are left alone.
- **Headers that mean the same thing are merged.** "Reg No", "Registration No" and "Registration Number" all fill one column; "Name", "Student name" and "Full Name" likewise. Anything else becomes its own column. The upload screen shows exactly how each column will be saved, and you can untick any column to leave it out.
- **Existing values are kept by default.** Only missing details are filled in. Tick *Replace values that are already saved* to update them. Blank cells never erase anything either way.
- **Neo IDs not in the database yet are added as new students.** The preview shows how many, so you can catch a wrong file before saving.
- Rows with a missing or invalid Neo ID are skipped and listed with their row number in the file.
- Always click **Preview changes** first. It shows exactly what saving will do, and nothing is written until you click **Save to database**. Re-uploading the same file is safe and changes nothing.

## Placements

On the admin page, type a company name, paste the Neo IDs of the students placed there, and click **Add to company**. Anything in the paste that isn't a Neo ID is ignored, so a whole email or list is fine.

- **A student can be in any number of companies.** Adding someone to a second company keeps the first. On the lookup page the Companies column lists all of a student's companies, alphabetically, and appears once any placement exists.
- **Company names match ignoring capital letters and extra spaces.** "tcs", " TCS " and "Tcs" are one company, shown with the spelling used the first time. Typing in the Company box suggests existing names.
- **Adding twice is harmless.** Students already in the company are counted and skipped.
- **IDs with no student record yet are still saved.** After saving, the admin page lists them, in case one is a typo. Fix it by clicking **Remove from company** with the wrong ID, then adding the right one.
- **Undo.** **Remove from company** takes the pasted students out of that company. A company with nobody left disappears. The table of companies has a **Delete** button that removes a company and all its placements.
- Placements are public on the lookup page like the rest of a student's details.

## Who can see what

- **Uploads and the admin page** need the admin password. The password is checked on the server, the session is a signed `HttpOnly` cookie that lasts 8 hours, and five wrong passwords lock an IP out for 15 minutes.
- **The lookup page is public**: no sign-in, and anyone with the link who knows a Neo ID can see that student's details. Only uploading needs the admin password.

## Run it locally

Needs Node 22 or newer.

```bash
npm install
cp .env.example .env.local     # then fill in the three values
npm run dev                    # http://localhost:3000
```

## Tests

```bash
npm test
```

Tests run against an in-memory Postgres, so they need no setup. To also test with your real spreadsheet, point `NEO_SAMPLE_XLSX` at it:

```bash
NEO_SAMPLE_XLSX=/path/to/students.xlsx npm test
```

## How it's built

Next.js (App Router) and TypeScript. Each student is one row: the Neo ID plus a JSON `data` object, so a new column never needs a database migration. Column order and display names live in a small `student_columns` table. Placements are a `companies` table plus a `placements` table with one row per student and company. All tables are created automatically the first time the app runs, including on an existing deployment.

| Path | What it does |
| --- | --- |
| `src/lib/neo.ts` | Neo ID rule, tokenizer, error messages |
| `src/lib/columns.ts` | Header cleanup, column matching, spreadsheet row parsing |
| `src/lib/merge.ts` | How an uploaded record merges into a stored one |
| `src/lib/students.ts` | Lookup, upload validation, preview and save |
| `src/lib/placements.ts` | Company names, adding and removing placements |
| `src/lib/sort.ts` | Column sorting for the results table |
| `src/lib/auth.ts` | Password check, session cookie, login throttle |
| `src/lib/db.ts` | Database access through Neon's serverless driver (one short-lived connection per operation) |
| `src/lib/env.ts` | Reads settings from `process.env` or, on Workers, from Cloudflare bindings |
| `src/app/api/health` | Deploy check: which settings are missing, can the database be reached |
| `src/app/api/*` | The HTTP endpoints |
