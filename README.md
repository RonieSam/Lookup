# Neo ID lookup

Paste Neo IDs, check each one, and see the matching student records. Admins can upload spreadsheets to add or update student details.

- **Lookup page (`/`)**: paste any text. Every word is checked on its own, several per line is fine. Results show found, not found and invalid IDs, and can be copied or downloaded as CSV.
- **Admin page (`/admin`)**: password-protected upload of `.xlsx` or `.csv` files. Columns the database doesn't have yet (Email, say) are created automatically.

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

4. **Deploy**, open `https://your-app.vercel.app/admin`, sign in, and upload your spreadsheet.

Free plans have usage limits and they change, so check the current limits for Neon and Vercel. This app stores a few megabytes for a few thousand students.

## Uploading details

- Students are matched on the **Neo ID column**. It's detected from the header ("Neo ID", "NeoID", …) or from the cell contents, and you can pick a different column.
- **New columns are created automatically.** Upload a sheet with an `Email` column and every matched student gets an email; students without one are left alone.
- **Headers that mean the same thing are merged.** "Reg No", "Registration No" and "Registration Number" all fill one column; "Name", "Student name" and "Full Name" likewise. Anything else becomes its own column. The upload screen shows exactly how each column will be saved, and you can untick any column to leave it out.
- **Existing values are kept by default.** Only missing details are filled in. Tick *Replace values that are already saved* to update them. Blank cells never erase anything either way.
- **Neo IDs not in the database yet are added as new students.** The preview shows how many, so you can catch a wrong file before saving.
- Rows with a missing or invalid Neo ID are skipped and listed with their row number in the file.
- Always click **Preview changes** first. It shows exactly what saving will do, and nothing is written until you click **Save to database**. Re-uploading the same file is safe and changes nothing.

## Who can see what

- **Uploads and the admin page** need the admin password. The password is checked on the server, the session is a signed `HttpOnly` cookie that lasts 8 hours, and five wrong passwords lock an IP out for 15 minutes.
- **The lookup page is public by default**: anyone with the link who knows a Neo ID can see that student's details. If that isn't what you want, set `REQUIRE_LOGIN_FOR_LOOKUP=true` and lookups will need the admin sign-in too.

## Run it locally

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

Next.js (App Router) and TypeScript. Each student is one row: the Neo ID plus a JSON `data` object, so a new column never needs a database migration. Column order and display names live in a small `student_columns` table.

| Path | What it does |
| --- | --- |
| `src/lib/neo.ts` | Neo ID rule, tokenizer, error messages |
| `src/lib/columns.ts` | Header cleanup, column matching, spreadsheet row parsing |
| `src/lib/merge.ts` | How an uploaded record merges into a stored one |
| `src/lib/students.ts` | Lookup, upload validation, preview and save |
| `src/lib/auth.ts` | Password check, session cookie, login throttle |
| `src/app/api/*` | The HTTP endpoints |
