# LinkedIn Safe Auto Report Checker

এটা Vercel-ready safe public LinkedIn profile checker।

## কী করে
- Bulk LinkedIn profile URL paste করা যাবে।
- `/api/check` দিয়ে public accessibility check করবে।
- যেগুলো নিশ্চিতভাবে পাওয়া যায় সেগুলো `OK / Active Public` দেখাবে।
- যেগুলো 404/removed/not found মনে হয় সেগুলো `Not OK / Possibly Ban` দেখাবে।
- LinkedIn block/login/authwall/rate-limit করলে `Unknown / Manual Needed` দেখাবে।
- Unknown গুলো দ্রুত manual verify করার জন্য queue, keyboard shortcut, CSV export আছে।

## Host করার নিয়ম
1. ZIP unzip করুন।
2. GitHub repo root-এ এই structure রাখুন:

```
index.html
package.json
README.md
api/check.js
```

3. Vercel → Add New Project → GitHub repo select → Deploy।
4. Deploy link open করে profile URL paste করুন।

## গুরুত্বপূর্ণ সীমাবদ্ধতা
এই app কোনো password/token/cookie/login নেয় না। LinkedIn automated request block করলে 100% auto result সম্ভব না। তাই safe workflow হলো: Auto check first, তারপর Unknown গুলো manual queue দিয়ে confirm।
