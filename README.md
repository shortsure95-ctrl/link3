# LinkedIn Public Profile Checker - Vercel Fixed

This version fixes the Vercel deployment error by removing the problematic `functions` pattern from `vercel.json`.
There is no `vercel.json` needed. Vercel automatically detects `/api/check.js`.

## Files

- `index.html` - Frontend
- `api/check.js` - Vercel Serverless API
- `package.json` - Minimal Node config

## Deploy

1. Upload these files to the root of a GitHub repository.
2. Make sure the repo structure is exactly:

```text
index.html
package.json
README.md
api/check.js
```

3. Import the repo in Vercel.
4. Leave Build Command empty/default.
5. Deploy.

## Important

- Do not upload the folder as a nested folder only. The files must be in the repository root.
- This checker does not use password, email, token, or cookie.
- `Not OK` is not a guaranteed ban result. It can also mean removed/unavailable/private/not found.
- `Unknown` usually means LinkedIn blocked or rate-limited the request.
