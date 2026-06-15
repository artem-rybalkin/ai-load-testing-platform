// Built-in k6 script templates for the Script Library page.
// Each template is a ready-to-run k6 script that users can load into
// "Custom Script" mode on the home page and adapt to their target.

export interface ScriptTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  script: string;
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: 'rest-api-load',
    name: 'REST API Load Test',
    description: 'GET + POST against a JSON API with status checks and p95/error-rate thresholds. Good starting point for most backend tests.',
    tags: ['backend', 'rest', 'load'],
    script: `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = 'https://example.com';

export default function () {
  const getRes = http.get(\`\${BASE_URL}/api/items\`);
  check(getRes, {
    'GET status is 200': (r) => r.status === 200,
  });

  const payload = JSON.stringify({ name: 'load-test-item', value: Math.random() });
  const postRes = http.post(\`\${BASE_URL}/api/items\`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });
  check(postRes, {
    'POST status is 201': (r) => r.status === 201,
  });

  sleep(1);
}
`,
  },
  {
    id: 'auth-flow',
    name: 'Authenticated Flow (Login + Token Reuse)',
    description: 'Logs in once per VU, extracts a bearer token from the response, then reuses it for subsequent authenticated requests.',
    tags: ['backend', 'auth', 'flow'],
    script: `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 5,
  duration: '1m',
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = 'https://example.com';

export default function () {
  // 1. Log in and grab the auth token
  const loginRes = http.post(\`\${BASE_URL}/api/login\`, JSON.stringify({
    username: 'test-user',
    password: 'test-password',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  check(loginRes, { 'login succeeded': (r) => r.status === 200 });
  const token = loginRes.json('token');

  const authHeaders = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: \`Bearer \${token}\`,
    },
  };

  // 2. Use the token for an authenticated request
  const meRes = http.get(\`\${BASE_URL}/api/me\`, authHeaders);
  check(meRes, { 'profile fetched': (r) => r.status === 200 });

  // 3. Perform an authenticated action
  const orderRes = http.post(\`\${BASE_URL}/api/orders\`, JSON.stringify({ item: 'widget', qty: 1 }), authHeaders);
  check(orderRes, { 'order created': (r) => r.status === 201 });

  sleep(1);
}
`,
  },
  {
    id: 'file-upload',
    name: 'File Upload',
    description: 'Uploads a small in-memory file via multipart/form-data — useful for testing upload endpoints.',
    tags: ['backend', 'upload', 'multipart'],
    script: `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 3,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = 'https://example.com';

// A small generated payload — replace with open(<path>, 'b') to upload a real file
const fileContent = 'load-test-file-content-'.repeat(50);

export default function () {
  const data = {
    field: 'value',
    file: http.file(fileContent, 'upload.txt', 'text/plain'),
  };

  const res = http.post(\`\${BASE_URL}/api/upload\`, data);
  check(res, {
    'upload accepted': (r) => r.status === 200 || r.status === 201,
  });

  sleep(1);
}
`,
  },
  {
    id: 'graphql-query',
    name: 'GraphQL Query',
    description: 'POSTs a GraphQL query with variables to a single /graphql endpoint and checks for a successful response with no errors.',
    tags: ['backend', 'graphql'],
    script: `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = 'https://example.com';

const query = \`
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      name
      price
    }
  }
\`;

export default function () {
  const payload = JSON.stringify({
    query,
    variables: { id: '1' },
  });

  const res = http.post(\`\${BASE_URL}/graphql\`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'no GraphQL errors': (r) => !JSON.parse(r.body as string).errors,
  });

  sleep(1);
}
`,
  },
  {
    id: 'spike-test',
    name: 'Spike Test with Thresholds',
    description: 'Staged ramp from baseline traffic to a sudden spike and back down — useful for testing autoscaling and resilience under bursts.',
    tags: ['backend', 'spike', 'thresholds'],
    script: `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // baseline
    { duration: '20s', target: 10 },   // hold baseline
    { duration: '10s', target: 200 },  // spike
    { duration: '30s', target: 200 },  // hold spike
    { duration: '20s', target: 10 },   // recover
    { duration: '20s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.05'],
  },
};

const BASE_URL = 'https://example.com';

export default function () {
  const res = http.get(BASE_URL);
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
`,
  },
];

export const findScriptTemplate = (id: string): ScriptTemplate | undefined =>
  SCRIPT_TEMPLATES.find(t => t.id === id);
