# Custom k6 Scripts

By default, the platform generates a k6 script automatically from your description using Gemini AI. If you prefer full control, you can supply your own k6 script directly.

Custom scripts **bypass AI generation entirely** — no Gemini API call is made, no script is cached, and the script is not stored in the database.

---

## Uploading a custom script in the UI

1. Go to **New Test** → **Backend** type
2. In the **Script source** toggle, select **Custom Script**
3. Either:
   - Paste your k6 script directly into the textarea, or
   - Click **Upload .js file** to load a file from disk
4. The **URL** field becomes optional — you can enter a label URL (shows in results), or leave it blank (the platform tries to extract a URL from the script)
5. Click **▶ Run Test**

The **Description** field is hidden in custom script mode — it's only used for AI generation.

---

## Via API

```bash
curl -X POST http://localhost:3000/tests \
  -H "Content-Type: application/json" \
  -d '{
    "type": "backend",
    "targetUrl": "https://api.example.com",
    "customScript": "import http from \"k6/http\";\nimport { check } from \"k6\";\n\nexport const options = { vus: 10, duration: \"30s\" };\n\nexport default function () {\n  const res = http.get(\"https://api.example.com/status\");\n  check(res, { \"status 200\": r => r.status === 200 });\n}\n"
  }'
```

**Constraints:**
- Maximum size: **512 KB**
- Must be valid k6 JavaScript (the platform validates with `k6 inspect` before running)
- `type` must be `"backend"` — custom scripts run in worker-backend (k6), not worker-client (Puppeteer)

---

## Writing a k6 script

k6 scripts are JavaScript files with a default export function that runs per VU per iteration.

### Minimal example

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
};

export default function () {
  const res = http.get('https://api.example.com/users');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
  sleep(1);
}
```

### Example with authentication

```javascript
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 20,
  duration: '1m',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // Login
  const loginRes = http.post('https://api.example.com/auth/login', JSON.stringify({
    username: __ENV.USERNAME || 'testuser',
    password: __ENV.PASSWORD || 'testpass',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  check(loginRes, { 'login 200': (r) => r.status === 200 });

  const token = loginRes.json('access_token');

  // Authenticated request
  const profileRes = http.get('https://api.example.com/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });

  check(profileRes, { 'profile 200': (r) => r.status === 200 });
}
```

Pass credentials via `envVars` in the request:
```json
{
  "envVars": { "USERNAME": "alice", "PASSWORD": "secret" }
}
```

### Load stages

Control the load shape manually with `stages`:

```javascript
export const options = {
  stages: [
    { duration: '30s', target: 10 },   // ramp up
    { duration: '2m',  target: 10 },   // hold
    { duration: '10s', target: 100 },  // spike
    { duration: '1m',  target: 100 },  // hold spike
    { duration: '30s', target: 0 },    // ramp down
  ],
};
```

### Data parameterization

Use `SharedArray` to supply per-VU data:

```javascript
import { SharedArray } from 'k6/data';

const users = new SharedArray('users', function () {
  return JSON.parse(open('./data.json'));
});

export default function () {
  const user = users[(__VU - 1) % users.length];
  // use user.username, user.password, etc.
}
```

Upload your data via the `testData` field (array of objects) or `csvData` (base64 CSV) — the platform writes them as `data.json` or `data.csv` in the k6 run directory.

---

## Script validation

Before execution, every script (AI-generated or custom) passes through `k6 inspect`, which checks syntax and module imports. Invalid scripts fail immediately with an error message — they don't consume a worker or retry slot.

---

## Downloading the generated script

After any completed test, the **Generated Script** card on the result detail page shows the k6 or Puppeteer script that was used. Click **↓ Download .js** to save it locally.

You can then:
- Inspect what Gemini generated
- Use it as a starting point for a custom script
- Upload it as a custom script to future tests (bypasses AI for instant re-run)

This is especially useful for iterating on a flow script — download the AI version, tweak it, and re-upload as a custom script.

---

## Script caching and reuse

When using AI-generated scripts (not custom), the platform caches the script in the `test_scripts` table keyed by URL + type. On subsequent runs:

1. If the same URL + type has a cached script and you provide **no description** → script is reused directly (instant, no Gemini call)
2. If you provide a **description** and a cached script exists → Gemini compares the descriptions and decides `REUSE` or `REGENERATE`
3. **Custom scripts always bypass this entirely** — they're never cached, and the cache is not consulted

To force AI regeneration of a cached script, delete it via the API:
```bash
curl -X DELETE http://localhost:3004/scripts/<scriptId>
```

Find the script ID on the result detail page or via `GET /scripts`.
