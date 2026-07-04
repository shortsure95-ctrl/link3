# LinkedIn Public Profile Status Checker - Vercel Ready

Safe best-effort checker for public LinkedIn profile URLs.

## Files

```
index.html
package.json
api/check.js
README.md
```

## Deploy

1. Upload all files to the root of your GitHub repo.
2. Import the repo in Vercel.
3. Keep build command empty/default.
4. Deploy.
5. Open the Vercel URL and paste LinkedIn profile links.

## Important limitations

- This does not use LinkedIn email/password/cookie/token.
- It only checks public URL availability.
- LinkedIn may block automated server requests with HTTP 999/403/429. In that case the result will be Unknown and manual verification is required.
- Not OK means possibly removed/not found/banned, not a guaranteed ban confirmation.

## Accuracy tips

Use small batch size and 1.5–5 second delay. For Unknown results, use the Manual Verify Queue.
