# TODO

## Manual Testing

- [ ] Manually test log integration
- [ ] Manually test script recording
- [ ] Manually test correlation
- [ ] Manually test client-side testing

## Future Features

- [ ] RUM (Real User Monitoring) — collect vitals from real end users via injected script snippet

## MEGA Features (requires deep investigation)

- [ ] Mobile application performance testing — investigate approaches: Appium/WebDriverIO for native apps, device farms (AWS Device Farm, BrowserStack), network throttling profiles, mobile-specific metrics (frame rate, battery, memory on device), Android/iOS instrumentation
- [ ] Natural language "one prompt" test creation — user describes entire test scenario in a single prompt; AI infers type (backend/browser/flow/mobile), extracts URL, steps, load profile, SLOs, env vars, and submits the full test without the user touching the form
