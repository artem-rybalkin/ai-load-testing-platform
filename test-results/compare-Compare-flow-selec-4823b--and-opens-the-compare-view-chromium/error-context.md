# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: compare.spec.ts >> Compare flow >> selects two results and opens the compare view
- Location: e2e\compare.spec.ts:37:3

# Error details

```
Test timeout of 300000ms exceeded.
```

```
Error: locator.click: Test timeout of 300000ms exceeded.
Call log:
  - waiting for locator('tr:has(a[href="/results/9495ad8d-d374-4b33-80d3-a5476479b67e"])').first().locator('input[type="checkbox"]')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - complementary [ref=e3]:
      - generic [ref=e4]:
        - generic [ref=e5]: ⚡ AI Load Testing
        - button "◀" [ref=e6]
      - navigation [ref=e7]:
        - link "⊕ New Test" [ref=e8] [cursor=pointer]:
          - /url: /
          - generic [ref=e9]: ⊕
          - generic [ref=e10]: New Test
        - link "≡ Results" [ref=e11] [cursor=pointer]:
          - /url: /results
          - generic [ref=e12]: ≡
          - generic [ref=e13]: Results
        - link "⏱ Schedules" [ref=e14] [cursor=pointer]:
          - /url: /schedules
          - generic [ref=e15]: ⏱
          - generic [ref=e16]: Schedules
        - link "◫ Templates" [ref=e17] [cursor=pointer]:
          - /url: /templates
          - generic [ref=e18]: ◫
          - generic [ref=e19]: Templates
        - link "◻ Webhooks" [ref=e20] [cursor=pointer]:
          - /url: /webhooks
          - generic [ref=e21]: ◻
          - generic [ref=e22]: Webhooks
    - generic [ref=e23]:
      - generic [ref=e25]:
        - generic [ref=e26]:
          - generic [ref=e29]: ⚡ k6
          - generic [ref=e30]:
            - generic [ref=e31]: CPU
            - generic [ref=e33]: 0%
          - generic [ref=e34]:
            - generic [ref=e35]: MEM
            - generic [ref=e38]: 1%
          - generic [ref=e39]: 0/1 tests
        - generic [ref=e40]:
          - generic [ref=e43]: 🌐 Browser
          - generic [ref=e44]:
            - generic [ref=e45]: CPU
            - generic [ref=e47]: 0%
          - generic [ref=e48]:
            - generic [ref=e49]: MEM
            - generic [ref=e52]: 2%
          - generic [ref=e53]: 0/2 tests
      - main [ref=e54]:
        - generic [ref=e55]:
          - generic [ref=e56]:
            - heading "Results" [level=1] [ref=e57]
            - link "+ New Test" [ref=e59] [cursor=pointer]:
              - /url: /
          - table [ref=e61]:
            - rowgroup [ref=e62]:
              - row "URL / Meta Type Status Analysis" [ref=e63]:
                - columnheader [ref=e64]
                - columnheader "URL / Meta" [ref=e65]
                - columnheader "Type" [ref=e66]
                - columnheader "Status" [ref=e67]
                - columnheader "Analysis" [ref=e68]
                - columnheader [ref=e69]
            - rowgroup [ref=e70]:
              - row "http://localhost:3000/health 4m ago backend cancelled View →" [ref=e71] [cursor=pointer]:
                - cell [ref=e72]
                - cell "http://localhost:3000/health 4m ago" [ref=e73]:
                  - generic [ref=e75]: http://localhost:3000/health
                  - generic [ref=e76]: 4m ago
                - cell "backend" [ref=e77]:
                  - generic [ref=e78]: backend
                - cell "cancelled" [ref=e79]:
                  - generic [ref=e80]: cancelled
                - cell [ref=e82]
                - cell "View →" [ref=e83]:
                  - link "View →" [ref=e84]:
                    - /url: /results/7fbec2f1-6586-4d28-a37c-a92de0acf9f0
              - row "http://localhost:3000/health 4m ago backend cancelled View →" [ref=e85] [cursor=pointer]:
                - cell [ref=e86]
                - cell "http://localhost:3000/health 4m ago" [ref=e87]:
                  - generic [ref=e89]: http://localhost:3000/health
                  - generic [ref=e90]: 4m ago
                - cell "backend" [ref=e91]:
                  - generic [ref=e92]: backend
                - cell "cancelled" [ref=e93]:
                  - generic [ref=e94]: cancelled
                - cell [ref=e96]
                - cell "View →" [ref=e97]:
                  - link "View →" [ref=e98]:
                    - /url: /results/15146164-5a21-4cd6-815d-77caa1bc7994
              - row "http://localhost:3000/health 4m ago backend cancelled View →" [ref=e99] [cursor=pointer]:
                - cell [ref=e100]
                - cell "http://localhost:3000/health 4m ago" [ref=e101]:
                  - generic [ref=e103]: http://localhost:3000/health
                  - generic [ref=e104]: 4m ago
                - cell "backend" [ref=e105]:
                  - generic [ref=e106]: backend
                - cell "cancelled" [ref=e107]:
                  - generic [ref=e108]: cancelled
                - cell [ref=e110]
                - cell "View →" [ref=e111]:
                  - link "View →" [ref=e112]:
                    - /url: /results/bead95ca-752b-4f6b-b45e-1a0a74be5788
              - row "http://localhost:3000/health 4m ago backend cancelled View →" [ref=e113] [cursor=pointer]:
                - cell [ref=e114]
                - cell "http://localhost:3000/health 4m ago" [ref=e115]:
                  - generic [ref=e117]: http://localhost:3000/health
                  - generic [ref=e118]: 4m ago
                - cell "backend" [ref=e119]:
                  - generic [ref=e120]: backend
                - cell "cancelled" [ref=e121]:
                  - generic [ref=e122]: cancelled
                - cell [ref=e124]
                - cell "View →" [ref=e125]:
                  - link "View →" [ref=e126]:
                    - /url: /results/9495ad8d-d374-4b33-80d3-a5476479b67e
              - row "http://localhost:3000/health 6m ago backend cancelled View →" [ref=e127] [cursor=pointer]:
                - cell [ref=e128]
                - cell "http://localhost:3000/health 6m ago" [ref=e129]:
                  - generic [ref=e131]: http://localhost:3000/health
                  - generic [ref=e132]: 6m ago
                - cell "backend" [ref=e133]:
                  - generic [ref=e134]: backend
                - cell "cancelled" [ref=e135]:
                  - generic [ref=e136]: cancelled
                - cell [ref=e138]
                - cell "View →" [ref=e139]:
                  - link "View →" [ref=e140]:
                    - /url: /results/b4ab4924-bb7c-4735-87ba-9b346a23d443
              - row "http://localhost:3000/health 7m ago backend cancelled View →" [ref=e141] [cursor=pointer]:
                - cell [ref=e142]
                - cell "http://localhost:3000/health 7m ago" [ref=e143]:
                  - generic [ref=e145]: http://localhost:3000/health
                  - generic [ref=e146]: 7m ago
                - cell "backend" [ref=e147]:
                  - generic [ref=e148]: backend
                - cell "cancelled" [ref=e149]:
                  - generic [ref=e150]: cancelled
                - cell [ref=e152]
                - cell "View →" [ref=e153]:
                  - link "View →" [ref=e154]:
                    - /url: /results/1890fe9a-81ad-4b15-9802-5936834f526d
              - row "http://localhost:3000/health 11m ago backend cancelled View →" [ref=e155] [cursor=pointer]:
                - cell [ref=e156]
                - cell "http://localhost:3000/health 11m ago" [ref=e157]:
                  - generic [ref=e159]: http://localhost:3000/health
                  - generic [ref=e160]: 11m ago
                - cell "backend" [ref=e161]:
                  - generic [ref=e162]: backend
                - cell "cancelled" [ref=e163]:
                  - generic [ref=e164]: cancelled
                - cell [ref=e166]
                - cell "View →" [ref=e167]:
                  - link "View →" [ref=e168]:
                    - /url: /results/11766898-b5ec-4f74-bef8-93cdf8fed2d4
              - row "http://localhost:3000/health 11m ago backend cancelled View →" [ref=e169] [cursor=pointer]:
                - cell [ref=e170]
                - cell "http://localhost:3000/health 11m ago" [ref=e171]:
                  - generic [ref=e173]: http://localhost:3000/health
                  - generic [ref=e174]: 11m ago
                - cell "backend" [ref=e175]:
                  - generic [ref=e176]: backend
                - cell "cancelled" [ref=e177]:
                  - generic [ref=e178]: cancelled
                - cell [ref=e180]
                - cell "View →" [ref=e181]:
                  - link "View →" [ref=e182]:
                    - /url: /results/35903962-01ce-47fd-8716-d2ee14dbe9a0
              - 'row "http://localhost:3000/health 11m agop95: 0ms · 0.5 rps backend completed failed View →" [ref=e183] [cursor=pointer]':
                - cell [ref=e184]:
                  - checkbox [ref=e185]
                - 'cell "http://localhost:3000/health 11m agop95: 0ms · 0.5 rps" [ref=e186]':
                  - generic [ref=e188]: http://localhost:3000/health
                  - generic [ref=e189]: "11m agop95: 0ms · 0.5 rps"
                - cell "backend" [ref=e190]:
                  - generic [ref=e191]: backend
                - cell "completed" [ref=e192]:
                  - generic [ref=e193]: completed
                - cell "failed" [ref=e195]:
                  - generic [ref=e196]: failed
                - cell "View →" [ref=e197]:
                  - link "View →" [ref=e198]:
                    - /url: /results/5e5d8703-8112-4d30-84e4-24aac450fc82
              - 'row "http://localhost:3000/health 11m agop95: 0ms · 0.5 rps backend completed failed View →" [ref=e199] [cursor=pointer]':
                - cell [ref=e200]:
                  - checkbox [ref=e201]
                - 'cell "http://localhost:3000/health 11m agop95: 0ms · 0.5 rps" [ref=e202]':
                  - generic [ref=e204]: http://localhost:3000/health
                  - generic [ref=e205]: "11m agop95: 0ms · 0.5 rps"
                - cell "backend" [ref=e206]:
                  - generic [ref=e207]: backend
                - cell "completed" [ref=e208]:
                  - generic [ref=e209]: completed
                - cell "failed" [ref=e211]:
                  - generic [ref=e212]: failed
                - cell "View →" [ref=e213]:
                  - link "View →" [ref=e214]:
                    - /url: /results/2d5b5d06-b5c0-4f08-913f-355a941a3d1e
              - 'row "http://localhost:3000/health 13m agop95: 0ms · 0.7 rps backend completed failed View →" [ref=e215] [cursor=pointer]':
                - cell [ref=e216]:
                  - checkbox [ref=e217]
                - 'cell "http://localhost:3000/health 13m agop95: 0ms · 0.7 rps" [ref=e218]':
                  - generic [ref=e220]: http://localhost:3000/health
                  - generic [ref=e221]: "13m agop95: 0ms · 0.7 rps"
                - cell "backend" [ref=e222]:
                  - generic [ref=e223]: backend
                - cell "completed" [ref=e224]:
                  - generic [ref=e225]: completed
                - cell "failed" [ref=e227]:
                  - generic [ref=e228]: failed
                - cell "View →" [ref=e229]:
                  - link "View →" [ref=e230]:
                    - /url: /results/16d8854b-f677-4353-aed4-e9564488f991
              - 'row "http://localhost:3000/health 13m agop95: 0ms · 2.4 rps backend completed failed View →" [ref=e231] [cursor=pointer]':
                - cell [ref=e232]:
                  - checkbox [ref=e233]
                - 'cell "http://localhost:3000/health 13m agop95: 0ms · 2.4 rps" [ref=e234]':
                  - generic [ref=e236]: http://localhost:3000/health
                  - generic [ref=e237]: "13m agop95: 0ms · 2.4 rps"
                - cell "backend" [ref=e238]:
                  - generic [ref=e239]: backend
                - cell "completed" [ref=e240]:
                  - generic [ref=e241]: completed
                - cell "failed" [ref=e243]:
                  - generic [ref=e244]: failed
                - cell "View →" [ref=e245]:
                  - link "View →" [ref=e246]:
                    - /url: /results/118f335e-fd90-4a33-8ec0-346adfb4e6e1
              - 'row "https://allegro.pl 18m agop95: 4920ms · 1.8 rps flow completed failed View →" [ref=e247] [cursor=pointer]':
                - cell [ref=e248]:
                  - checkbox [ref=e249]
                - 'cell "https://allegro.pl 18m agop95: 4920ms · 1.8 rps" [ref=e250]':
                  - generic [ref=e252]: https://allegro.pl
                  - generic [ref=e253]: "18m agop95: 4920ms · 1.8 rps"
                - cell "flow" [ref=e254]:
                  - generic [ref=e255]: flow
                - cell "completed" [ref=e256]:
                  - generic [ref=e257]: completed
                - cell "failed" [ref=e259]:
                  - generic [ref=e260]: failed
                - cell "View →" [ref=e261]:
                  - link "View →" [ref=e262]:
                    - /url: /results/fdf01d04-b951-4c6c-ac93-3705b1eac541
              - row "http://localhost:3000/health 19m ago backend cancelled View →" [ref=e263] [cursor=pointer]:
                - cell [ref=e264]
                - cell "http://localhost:3000/health 19m ago" [ref=e265]:
                  - generic [ref=e267]: http://localhost:3000/health
                  - generic [ref=e268]: 19m ago
                - cell "backend" [ref=e269]:
                  - generic [ref=e270]: backend
                - cell "cancelled" [ref=e271]:
                  - generic [ref=e272]: cancelled
                - cell [ref=e274]
                - cell "View →" [ref=e275]:
                  - link "View →" [ref=e276]:
                    - /url: /results/806094fe-3597-48e4-9253-2dcd2563cc24
              - 'row "http://localhost:3000/health 19m agop95: 0ms · 1.8 rps backend completed failed View →" [ref=e277] [cursor=pointer]':
                - cell [ref=e278]:
                  - checkbox [ref=e279]
                - 'cell "http://localhost:3000/health 19m agop95: 0ms · 1.8 rps" [ref=e280]':
                  - generic [ref=e282]: http://localhost:3000/health
                  - generic [ref=e283]: "19m agop95: 0ms · 1.8 rps"
                - cell "backend" [ref=e284]:
                  - generic [ref=e285]: backend
                - cell "completed" [ref=e286]:
                  - generic [ref=e287]: completed
                - cell "failed" [ref=e289]:
                  - generic [ref=e290]: failed
                - cell "View →" [ref=e291]:
                  - link "View →" [ref=e292]:
                    - /url: /results/9fd44d75-ef0d-4537-88fd-08224fc97ea9
              - 'row "http://localhost:3000/health 19m agop95: 0ms · 0.5 rps backend completed failed View →" [ref=e293] [cursor=pointer]':
                - cell [ref=e294]:
                  - checkbox [ref=e295]
                - 'cell "http://localhost:3000/health 19m agop95: 0ms · 0.5 rps" [ref=e296]':
                  - generic [ref=e298]: http://localhost:3000/health
                  - generic [ref=e299]: "19m agop95: 0ms · 0.5 rps"
                - cell "backend" [ref=e300]:
                  - generic [ref=e301]: backend
                - cell "completed" [ref=e302]:
                  - generic [ref=e303]: completed
                - cell "failed" [ref=e305]:
                  - generic [ref=e306]: failed
                - cell "View →" [ref=e307]:
                  - link "View →" [ref=e308]:
                    - /url: /results/bb18d3e4-9596-4342-b595-55afd4ef8163
              - 'row "http://localhost:3000/health 19m agop95: 0ms · 0.7 rps backend completed failed View →" [ref=e309] [cursor=pointer]':
                - cell [ref=e310]:
                  - checkbox [ref=e311]
                - 'cell "http://localhost:3000/health 19m agop95: 0ms · 0.7 rps" [ref=e312]':
                  - generic [ref=e314]: http://localhost:3000/health
                  - generic [ref=e315]: "19m agop95: 0ms · 0.7 rps"
                - cell "backend" [ref=e316]:
                  - generic [ref=e317]: backend
                - cell "completed" [ref=e318]:
                  - generic [ref=e319]: completed
                - cell "failed" [ref=e321]:
                  - generic [ref=e322]: failed
                - cell "View →" [ref=e323]:
                  - link "View →" [ref=e324]:
                    - /url: /results/720682bf-de62-4e50-beda-a34f48034609
              - 'row "http://localhost:3000/health 19m agop95: 0ms · 0.7 rps backend completed failed View →" [ref=e325] [cursor=pointer]':
                - cell [ref=e326]:
                  - checkbox [ref=e327]
                - 'cell "http://localhost:3000/health 19m agop95: 0ms · 0.7 rps" [ref=e328]':
                  - generic [ref=e330]: http://localhost:3000/health
                  - generic [ref=e331]: "19m agop95: 0ms · 0.7 rps"
                - cell "backend" [ref=e332]:
                  - generic [ref=e333]: backend
                - cell "completed" [ref=e334]:
                  - generic [ref=e335]: completed
                - cell "failed" [ref=e337]:
                  - generic [ref=e338]: failed
                - cell "View →" [ref=e339]:
                  - link "View →" [ref=e340]:
                    - /url: /results/8bb679d6-502f-4a4a-bfb6-c088dfe24e62
              - 'row "http://localhost:3000/health 19m agop95: 0ms · 1.9 rps backend completed failed View →" [ref=e341] [cursor=pointer]':
                - cell [ref=e342]:
                  - checkbox [ref=e343]
                - 'cell "http://localhost:3000/health 19m agop95: 0ms · 1.9 rps" [ref=e344]':
                  - generic [ref=e346]: http://localhost:3000/health
                  - generic [ref=e347]: "19m agop95: 0ms · 1.9 rps"
                - cell "backend" [ref=e348]:
                  - generic [ref=e349]: backend
                - cell "completed" [ref=e350]:
                  - generic [ref=e351]: completed
                - cell "failed" [ref=e353]:
                  - generic [ref=e354]: failed
                - cell "View →" [ref=e355]:
                  - link "View →" [ref=e356]:
                    - /url: /results/8ded44a6-24eb-418f-b456-247f9752a82e
              - 'row "http://localhost:3000/health 22m agop95: 0ms · 1.8 rps backend completed failed View →" [ref=e357] [cursor=pointer]':
                - cell [ref=e358]:
                  - checkbox [ref=e359]
                - 'cell "http://localhost:3000/health 22m agop95: 0ms · 1.8 rps" [ref=e360]':
                  - generic [ref=e362]: http://localhost:3000/health
                  - generic [ref=e363]: "22m agop95: 0ms · 1.8 rps"
                - cell "backend" [ref=e364]:
                  - generic [ref=e365]: backend
                - cell "completed" [ref=e366]:
                  - generic [ref=e367]: completed
                - cell "failed" [ref=e369]:
                  - generic [ref=e370]: failed
                - cell "View →" [ref=e371]:
                  - link "View →" [ref=e372]:
                    - /url: /results/163986b0-72fd-4b9f-aa27-d21153436bf4
              - 'row "http://localhost:3000/health 23m agop95: 0ms · 0.7 rps backend completed failed View →" [ref=e373] [cursor=pointer]':
                - cell [ref=e374]:
                  - checkbox [ref=e375]
                - 'cell "http://localhost:3000/health 23m agop95: 0ms · 0.7 rps" [ref=e376]':
                  - generic [ref=e378]: http://localhost:3000/health
                  - generic [ref=e379]: "23m agop95: 0ms · 0.7 rps"
                - cell "backend" [ref=e380]:
                  - generic [ref=e381]: backend
                - cell "completed" [ref=e382]:
                  - generic [ref=e383]: completed
                - cell "failed" [ref=e385]:
                  - generic [ref=e386]: failed
                - cell "View →" [ref=e387]:
                  - link "View →" [ref=e388]:
                    - /url: /results/e6469c44-ad4f-4888-948a-9bacdff67f54
              - 'row "http://localhost:3000/health 24m agop95: 0ms · 1.8 rps backend completed failed View →" [ref=e389] [cursor=pointer]':
                - cell [ref=e390]:
                  - checkbox [ref=e391]
                - 'cell "http://localhost:3000/health 24m agop95: 0ms · 1.8 rps" [ref=e392]':
                  - generic [ref=e394]: http://localhost:3000/health
                  - generic [ref=e395]: "24m agop95: 0ms · 1.8 rps"
                - cell "backend" [ref=e396]:
                  - generic [ref=e397]: backend
                - cell "completed" [ref=e398]:
                  - generic [ref=e399]: completed
                - cell "failed" [ref=e401]:
                  - generic [ref=e402]: failed
                - cell "View →" [ref=e403]:
                  - link "View →" [ref=e404]:
                    - /url: /results/c5dc62ac-4324-4412-ad0a-e9b7fbaf515d
              - 'row "http://localhost:3000/health 26m agop95: 0ms · 1.8 rps backend completed failed View →" [ref=e405] [cursor=pointer]':
                - cell [ref=e406]:
                  - checkbox [ref=e407]
                - 'cell "http://localhost:3000/health 26m agop95: 0ms · 1.8 rps" [ref=e408]':
                  - generic [ref=e410]: http://localhost:3000/health
                  - generic [ref=e411]: "26m agop95: 0ms · 1.8 rps"
                - cell "backend" [ref=e412]:
                  - generic [ref=e413]: backend
                - cell "completed" [ref=e414]:
                  - generic [ref=e415]: completed
                - cell "failed" [ref=e417]:
                  - generic [ref=e418]: failed
                - cell "View →" [ref=e419]:
                  - link "View →" [ref=e420]:
                    - /url: /results/78287b82-59d0-4cf6-b6ea-7c334046be2f
              - 'row "http://localhost:3000/health 27m agop95: 0ms · 0.8 rps backend completed failed View →" [ref=e421] [cursor=pointer]':
                - cell [ref=e422]:
                  - checkbox [ref=e423]
                - 'cell "http://localhost:3000/health 27m agop95: 0ms · 0.8 rps" [ref=e424]':
                  - generic [ref=e426]: http://localhost:3000/health
                  - generic [ref=e427]: "27m agop95: 0ms · 0.8 rps"
                - cell "backend" [ref=e428]:
                  - generic [ref=e429]: backend
                - cell "completed" [ref=e430]:
                  - generic [ref=e431]: completed
                - cell "failed" [ref=e433]:
                  - generic [ref=e434]: failed
                - cell "View →" [ref=e435]:
                  - link "View →" [ref=e436]:
                    - /url: /results/19ed1ac1-0fad-4dff-a592-2a00155aeeae
              - 'row "http://localhost:3000/health 28m agop95: 0ms · 1.8 rps backend completed failed View →" [ref=e437] [cursor=pointer]':
                - cell [ref=e438]:
                  - checkbox [ref=e439]
                - 'cell "http://localhost:3000/health 28m agop95: 0ms · 1.8 rps" [ref=e440]':
                  - generic [ref=e442]: http://localhost:3000/health
                  - generic [ref=e443]: "28m agop95: 0ms · 1.8 rps"
                - cell "backend" [ref=e444]:
                  - generic [ref=e445]: backend
                - cell "completed" [ref=e446]:
                  - generic [ref=e447]: completed
                - cell "failed" [ref=e449]:
                  - generic [ref=e450]: failed
                - cell "View →" [ref=e451]:
                  - link "View →" [ref=e452]:
                    - /url: /results/9d269610-b3b6-4730-a8cd-2b658eac73de
              - 'row "http://localhost:3000/health 28m agop95: 0ms · 2.5 rps backend completed failed View →" [ref=e453] [cursor=pointer]':
                - cell [ref=e454]:
                  - checkbox [ref=e455]
                - 'cell "http://localhost:3000/health 28m agop95: 0ms · 2.5 rps" [ref=e456]':
                  - generic [ref=e458]: http://localhost:3000/health
                  - generic [ref=e459]: "28m agop95: 0ms · 2.5 rps"
                - cell "backend" [ref=e460]:
                  - generic [ref=e461]: backend
                - cell "completed" [ref=e462]:
                  - generic [ref=e463]: completed
                - cell "failed" [ref=e465]:
                  - generic [ref=e466]: failed
                - cell "View →" [ref=e467]:
                  - link "View →" [ref=e468]:
                    - /url: /results/d49c80f1-9138-4fdd-8805-69a8788f1009
              - row "https://uefa.com 1d ago backend cancelled View →" [ref=e469] [cursor=pointer]:
                - cell [ref=e470]
                - cell "https://uefa.com 1d ago" [ref=e471]:
                  - generic [ref=e473]: https://uefa.com
                  - generic [ref=e474]: 1d ago
                - cell "backend" [ref=e475]:
                  - generic [ref=e476]: backend
                - cell "cancelled" [ref=e477]:
                  - generic [ref=e478]: cancelled
                - cell [ref=e480]
                - cell "View →" [ref=e481]:
                  - link "View →" [ref=e482]:
                    - /url: /results/39989797-03b2-4294-af17-4b0ec7fa39d2
              - row "https://home.fr 1d ago backend cancelled View →" [ref=e483] [cursor=pointer]:
                - cell [ref=e484]
                - cell "https://home.fr 1d ago" [ref=e485]:
                  - generic [ref=e487]: https://home.fr
                  - generic [ref=e488]: 1d ago
                - cell "backend" [ref=e489]:
                  - generic [ref=e490]: backend
                - cell "cancelled" [ref=e491]:
                  - generic [ref=e492]: cancelled
                - cell [ref=e494]
                - cell "View →" [ref=e495]:
                  - link "View →" [ref=e496]:
                    - /url: /results/d20bb3ed-1d7c-4261-9faf-9bf2ee9ef4a2
              - 'row "https://uefa.com 1d agop95: 408ms · 4.4 rps backend completed passed View →" [ref=e497] [cursor=pointer]':
                - cell [ref=e498]:
                  - checkbox [ref=e499]
                - 'cell "https://uefa.com 1d agop95: 408ms · 4.4 rps" [ref=e500]':
                  - generic [ref=e502]: https://uefa.com
                  - generic [ref=e503]: "1d agop95: 408ms · 4.4 rps"
                - cell "backend" [ref=e504]:
                  - generic [ref=e505]: backend
                - cell "completed" [ref=e506]:
                  - generic [ref=e507]: completed
                - cell "passed" [ref=e509]:
                  - generic [ref=e510]: passed
                - cell "View →" [ref=e511]:
                  - link "View →" [ref=e512]:
                    - /url: /results/6995eeb3-3ad2-4d99-afea-182bd4a96305
              - 'row "https://home.fr 2d agop95: 0ms · 0.5 rps backend completed failed View →" [ref=e513] [cursor=pointer]':
                - cell [ref=e514]:
                  - checkbox [ref=e515]
                - 'cell "https://home.fr 2d agop95: 0ms · 0.5 rps" [ref=e516]':
                  - generic [ref=e518]: https://home.fr
                  - generic [ref=e519]: "2d agop95: 0ms · 0.5 rps"
                - cell "backend" [ref=e520]:
                  - generic [ref=e521]: backend
                - cell "completed" [ref=e522]:
                  - generic [ref=e523]: completed
                - cell "failed" [ref=e525]:
                  - generic [ref=e526]: failed
                - cell "View →" [ref=e527]:
                  - link "View →" [ref=e528]:
                    - /url: /results/457c1c32-4367-4ecc-9b63-ed641815ab58
              - row "https://picture.org 2d ago client-side cancelled View →" [ref=e529] [cursor=pointer]:
                - cell [ref=e530]
                - cell "https://picture.org 2d ago" [ref=e531]:
                  - generic [ref=e533]: https://picture.org
                  - generic [ref=e534]: 2d ago
                - cell "client-side" [ref=e535]:
                  - generic [ref=e536]: client-side
                - cell "cancelled" [ref=e537]:
                  - generic [ref=e538]: cancelled
                - cell [ref=e540]
                - cell "View →" [ref=e541]:
                  - link "View →" [ref=e542]:
                    - /url: /results/d3eafcf3-e898-4e22-8f4f-6bf928e5de80
              - 'row "https://home.tr 2d agop95: 0ms · 0.4 rps backend completed failed View →" [ref=e543] [cursor=pointer]':
                - cell [ref=e544]:
                  - checkbox [ref=e545]
                - 'cell "https://home.tr 2d agop95: 0ms · 0.4 rps" [ref=e546]':
                  - generic [ref=e548]: https://home.tr
                  - generic [ref=e549]: "2d agop95: 0ms · 0.4 rps"
                - cell "backend" [ref=e550]:
                  - generic [ref=e551]: backend
                - cell "completed" [ref=e552]:
                  - generic [ref=e553]: completed
                - cell "failed" [ref=e555]:
                  - generic [ref=e556]: failed
                - cell "View →" [ref=e557]:
                  - link "View →" [ref=e558]:
                    - /url: /results/7b148b93-8d57-4fb6-b5ac-4f3bccb5f4fe
              - row "https://home.fr 2d ago client-side cancelled View →" [ref=e559] [cursor=pointer]:
                - cell [ref=e560]
                - cell "https://home.fr 2d ago" [ref=e561]:
                  - generic [ref=e563]: https://home.fr
                  - generic [ref=e564]: 2d ago
                - cell "client-side" [ref=e565]:
                  - generic [ref=e566]: client-side
                - cell "cancelled" [ref=e567]:
                  - generic [ref=e568]: cancelled
                - cell [ref=e570]
                - cell "View →" [ref=e571]:
                  - link "View →" [ref=e572]:
                    - /url: /results/a0192696-41a6-4025-80e4-93860aa98a75
              - row "https://home.fr 2d ago client-side cancelled View →" [ref=e573] [cursor=pointer]:
                - cell [ref=e574]
                - cell "https://home.fr 2d ago" [ref=e575]:
                  - generic [ref=e577]: https://home.fr
                  - generic [ref=e578]: 2d ago
                - cell "client-side" [ref=e579]:
                  - generic [ref=e580]: client-side
                - cell "cancelled" [ref=e581]:
                  - generic [ref=e582]: cancelled
                - cell [ref=e584]
                - cell "View →" [ref=e585]:
                  - link "View →" [ref=e586]:
                    - /url: /results/10483fda-a2e4-4e1b-bd1d-8d4bb1bfb466
              - 'row "https://home.fr 2d agop95: 0ms · 0.4 rps backend completed failed View →" [ref=e587] [cursor=pointer]':
                - cell [ref=e588]:
                  - checkbox [ref=e589]
                - 'cell "https://home.fr 2d agop95: 0ms · 0.4 rps" [ref=e590]':
                  - generic [ref=e592]: https://home.fr
                  - generic [ref=e593]: "2d agop95: 0ms · 0.4 rps"
                - cell "backend" [ref=e594]:
                  - generic [ref=e595]: backend
                - cell "completed" [ref=e596]:
                  - generic [ref=e597]: completed
                - cell "failed" [ref=e599]:
                  - generic [ref=e600]: failed
                - cell "View →" [ref=e601]:
                  - link "View →" [ref=e602]:
                    - /url: /results/a4756683-8e9d-4230-a6a1-613dbc13725a
              - 'row "https://example.com 2d agoLCP: 124ms · TTFB: 1060ms client-side completed failed View →" [ref=e603] [cursor=pointer]':
                - cell [ref=e604]:
                  - checkbox [ref=e605]
                - 'cell "https://example.com 2d agoLCP: 124ms · TTFB: 1060ms" [ref=e606]':
                  - generic [ref=e608]: https://example.com
                  - generic [ref=e609]: "2d agoLCP: 124ms · TTFB: 1060ms"
                - cell "client-side" [ref=e610]:
                  - generic [ref=e611]: client-side
                - cell "completed" [ref=e612]:
                  - generic [ref=e613]: completed
                - cell "failed" [ref=e615]:
                  - generic [ref=e616]: failed
                - cell "View →" [ref=e617]:
                  - link "View →" [ref=e618]:
                    - /url: /results/36e52209-e409-4b9f-a723-ad4ecee748f8
              - row "https://exam.ue 2d ago client-side cancelled View →" [ref=e619] [cursor=pointer]:
                - cell [ref=e620]
                - cell "https://exam.ue 2d ago" [ref=e621]:
                  - generic [ref=e623]: https://exam.ue
                  - generic [ref=e624]: 2d ago
                - cell "client-side" [ref=e625]:
                  - generic [ref=e626]: client-side
                - cell "cancelled" [ref=e627]:
                  - generic [ref=e628]: cancelled
                - cell [ref=e630]
                - cell "View →" [ref=e631]:
                  - link "View →" [ref=e632]:
                    - /url: /results/1e7a5d06-2853-477b-9eab-41016327c8ab
              - row "https://ragby.es 2d ago backend cancelled View →" [ref=e633] [cursor=pointer]:
                - cell [ref=e634]
                - cell "https://ragby.es 2d ago" [ref=e635]:
                  - generic [ref=e637]: https://ragby.es
                  - generic [ref=e638]: 2d ago
                - cell "backend" [ref=e639]:
                  - generic [ref=e640]: backend
                - cell "cancelled" [ref=e641]:
                  - generic [ref=e642]: cancelled
                - cell [ref=e644]
                - cell "View →" [ref=e645]:
                  - link "View →" [ref=e646]:
                    - /url: /results/da084f32-7cfd-43cd-b3d2-3b0b75e7afef
              - 'row "https://garden.com 2d agoLCP: 1834ms · TTFB: 2833ms client-side completed failed View →" [ref=e647] [cursor=pointer]':
                - cell [ref=e648]:
                  - checkbox [ref=e649]
                - 'cell "https://garden.com 2d agoLCP: 1834ms · TTFB: 2833ms" [ref=e650]':
                  - generic [ref=e652]: https://garden.com
                  - generic [ref=e653]: "2d agoLCP: 1834ms · TTFB: 2833ms"
                - cell "client-side" [ref=e654]:
                  - generic [ref=e655]: client-side
                - cell "completed" [ref=e656]:
                  - generic [ref=e657]: completed
                - cell "failed" [ref=e659]:
                  - generic [ref=e660]: failed
                - cell "View →" [ref=e661]:
                  - link "View →" [ref=e662]:
                    - /url: /results/9fe46f88-d93b-4f5d-8a25-1a73e8b79689
              - 'row "https://homepage.com 4d agop95: 834ms · 0.6 rps flow completed failed View →" [ref=e663] [cursor=pointer]':
                - cell [ref=e664]:
                  - checkbox [ref=e665]
                - 'cell "https://homepage.com 4d agop95: 834ms · 0.6 rps" [ref=e666]':
                  - generic [ref=e668]: https://homepage.com
                  - generic [ref=e669]: "4d agop95: 834ms · 0.6 rps"
                - cell "flow" [ref=e670]:
                  - generic [ref=e671]: flow
                - cell "completed" [ref=e672]:
                  - generic [ref=e673]: completed
                - cell "failed" [ref=e675]:
                  - generic [ref=e676]: failed
                - cell "View →" [ref=e677]:
                  - link "View →" [ref=e678]:
                    - /url: /results/8bc5c36e-691a-434e-9be3-09198e9e4dd9
              - 'row "https://soccer.com 4d agop95: 57ms · 3.4 rps backend completed failed View →" [ref=e679] [cursor=pointer]':
                - cell [ref=e680]:
                  - checkbox [ref=e681]
                - 'cell "https://soccer.com 4d agop95: 57ms · 3.4 rps" [ref=e682]':
                  - generic [ref=e684]: https://soccer.com
                  - generic [ref=e685]: "4d agop95: 57ms · 3.4 rps"
                - cell "backend" [ref=e686]:
                  - generic [ref=e687]: backend
                - cell "completed" [ref=e688]:
                  - generic [ref=e689]: completed
                - cell "failed" [ref=e691]:
                  - generic [ref=e692]: failed
                - cell "View →" [ref=e693]:
                  - link "View →" [ref=e694]:
                    - /url: /results/acc6c5d6-a758-48de-a93e-00fb24581fd7
              - 'row "perftest.com 4d agop95: 196ms · 3.9 rps backend completed passed View →" [ref=e695] [cursor=pointer]':
                - cell [ref=e696]:
                  - checkbox [ref=e697]
                - 'cell "perftest.com 4d agop95: 196ms · 3.9 rps" [ref=e698]':
                  - generic [ref=e700]: perftest.com
                  - generic [ref=e701]: "4d agop95: 196ms · 3.9 rps"
                - cell "backend" [ref=e702]:
                  - generic [ref=e703]: backend
                - cell "completed" [ref=e704]:
                  - generic [ref=e705]: completed
                - cell "passed" [ref=e707]:
                  - generic [ref=e708]: passed
                - cell "View →" [ref=e709]:
                  - link "View →" [ref=e710]:
                    - /url: /results/9a1c72db-d85d-4b6d-81bf-868d8c7c1f17
              - 'row "football.ru 4d agop95: 0ms · 0.0 rps backend completed passed View →" [ref=e711] [cursor=pointer]':
                - cell [ref=e712]:
                  - checkbox [ref=e713]
                - 'cell "football.ru 4d agop95: 0ms · 0.0 rps" [ref=e714]':
                  - generic [ref=e716]: football.ru
                  - generic [ref=e717]: "4d agop95: 0ms · 0.0 rps"
                - cell "backend" [ref=e718]:
                  - generic [ref=e719]: backend
                - cell "completed" [ref=e720]:
                  - generic [ref=e721]: completed
                - cell "passed" [ref=e723]:
                  - generic [ref=e724]: passed
                - cell "View →" [ref=e725]:
                  - link "View →" [ref=e726]:
                    - /url: /results/5f48cc50-420c-4a48-b6b1-26f76744eeba
              - 'row "https:salsa.com 4d agop95: 0ms · 1.3 rps backend completed failed View →" [ref=e727] [cursor=pointer]':
                - cell [ref=e728]:
                  - checkbox [ref=e729]
                - 'cell "https:salsa.com 4d agop95: 0ms · 1.3 rps" [ref=e730]':
                  - generic [ref=e732]: https:salsa.com
                  - generic [ref=e733]: "4d agop95: 0ms · 1.3 rps"
                - cell "backend" [ref=e734]:
                  - generic [ref=e735]: backend
                - cell "completed" [ref=e736]:
                  - generic [ref=e737]: completed
                - cell "failed" [ref=e739]:
                  - generic [ref=e740]: failed
                - cell "View →" [ref=e741]:
                  - link "View →" [ref=e742]:
                    - /url: /results/0192d83d-b8a3-4116-aa4e-b3d501d3ba43
              - 'row "https://football.ue 4d agop95: 0ms · 4.5 rps backend completed failed View →" [ref=e743] [cursor=pointer]':
                - cell [ref=e744]:
                  - checkbox [ref=e745]
                - 'cell "https://football.ue 4d agop95: 0ms · 4.5 rps" [ref=e746]':
                  - generic [ref=e748]: https://football.ue
                  - generic [ref=e749]: "4d agop95: 0ms · 4.5 rps"
                - cell "backend" [ref=e750]:
                  - generic [ref=e751]: backend
                - cell "completed" [ref=e752]:
                  - generic [ref=e753]: completed
                - cell "failed" [ref=e755]:
                  - generic [ref=e756]: failed
                - cell "View →" [ref=e757]:
                  - link "View →" [ref=e758]:
                    - /url: /results/a444c3ae-889b-47b6-9bb8-387dec1cb1b3
              - 'row "https://example.com 4d agop95: 18ms · 4.3 rps backend completed failed View →" [ref=e759] [cursor=pointer]':
                - cell [ref=e760]:
                  - checkbox [ref=e761]
                - 'cell "https://example.com 4d agop95: 18ms · 4.3 rps" [ref=e762]':
                  - generic [ref=e764]: https://example.com
                  - generic [ref=e765]: "4d agop95: 18ms · 4.3 rps"
                - cell "backend" [ref=e766]:
                  - generic [ref=e767]: backend
                - cell "completed" [ref=e768]:
                  - generic [ref=e769]: completed
                - cell "failed" [ref=e771]:
                  - generic [ref=e772]: failed
                - cell "View →" [ref=e773]:
                  - link "View →" [ref=e774]:
                    - /url: /results/da0ab3d0-0063-4771-ad2f-b2d8c3e7019f
              - 'row "https://example.com 4d agop95: 30ms · 4.5 rps backend completed failed View →" [ref=e775] [cursor=pointer]':
                - cell [ref=e776]:
                  - checkbox [ref=e777]
                - 'cell "https://example.com 4d agop95: 30ms · 4.5 rps" [ref=e778]':
                  - generic [ref=e780]: https://example.com
                  - generic [ref=e781]: "4d agop95: 30ms · 4.5 rps"
                - cell "backend" [ref=e782]:
                  - generic [ref=e783]: backend
                - cell "completed" [ref=e784]:
                  - generic [ref=e785]: completed
                - cell "failed" [ref=e787]:
                  - generic [ref=e788]: failed
                - cell "View →" [ref=e789]:
                  - link "View →" [ref=e790]:
                    - /url: /results/ddc87a43-f24a-4009-99ec-946c4b455393
              - 'row "https://football.com 5d agop95: 132ms · 14.4 rps backend completed passed View →" [ref=e791] [cursor=pointer]':
                - cell [ref=e792]:
                  - checkbox [ref=e793]
                - 'cell "https://football.com 5d agop95: 132ms · 14.4 rps" [ref=e794]':
                  - generic [ref=e796]: https://football.com
                  - generic [ref=e797]: "5d agop95: 132ms · 14.4 rps"
                - cell "backend" [ref=e798]:
                  - generic [ref=e799]: backend
                - cell "completed" [ref=e800]:
                  - generic [ref=e801]: completed
                - cell "passed" [ref=e803]:
                  - generic [ref=e804]: passed
                - cell "View →" [ref=e805]:
                  - link "View →" [ref=e806]:
                    - /url: /results/7b27fa3f-59ca-4b05-9a44-5fb321a6f520
              - 'row "https://example.com 5d agop95: 60ms · 2.1 rps backend completed failed View →" [ref=e807] [cursor=pointer]':
                - cell [ref=e808]:
                  - checkbox [ref=e809]
                - 'cell "https://example.com 5d agop95: 60ms · 2.1 rps" [ref=e810]':
                  - generic [ref=e812]: https://example.com
                  - generic [ref=e813]: "5d agop95: 60ms · 2.1 rps"
                - cell "backend" [ref=e814]:
                  - generic [ref=e815]: backend
                - cell "completed" [ref=e816]:
                  - generic [ref=e817]: completed
                - cell "failed" [ref=e819]:
                  - generic [ref=e820]: failed
                - cell "View →" [ref=e821]:
                  - link "View →" [ref=e822]:
                    - /url: /results/a77f3725-13a7-464c-9e39-b9abc61a2fe9
              - 'row "https://example.com 5d agop95: 60ms · 1.7 rps backend completed failed View →" [ref=e823] [cursor=pointer]':
                - cell [ref=e824]:
                  - checkbox [ref=e825]
                - 'cell "https://example.com 5d agop95: 60ms · 1.7 rps" [ref=e826]':
                  - generic [ref=e828]: https://example.com
                  - generic [ref=e829]: "5d agop95: 60ms · 1.7 rps"
                - cell "backend" [ref=e830]:
                  - generic [ref=e831]: backend
                - cell "completed" [ref=e832]:
                  - generic [ref=e833]: completed
                - cell "failed" [ref=e835]:
                  - generic [ref=e836]: failed
                - cell "View →" [ref=e837]:
                  - link "View →" [ref=e838]:
                    - /url: /results/fbf38116-87b8-4d8f-bbbb-fa68f9172591
  - alert [ref=e839]
```

# Test source

```ts
  1  | import { test, expect, Page } from '@playwright/test';
  2  | 
  3  | /**
  4  |  * Compare flow: seed two completed results via the API, navigate to the
  5  |  * results list, select both, and verify the compare view loads correctly.
  6  |  * Requires: docker compose up.
  7  |  */
  8  | 
  9  | const API_URL = 'http://localhost:3000';
  10 | const RESULTS_URL = 'http://localhost:3004';
  11 | 
  12 | async function createAndWaitForResult(page: Page): Promise<string> {
  13 |   const res = await page.request.post(`${API_URL}/tests`, {
  14 |     data: {
  15 |       type: 'backend',
  16 |       targetUrl: 'http://localhost:3000/health',
  17 |       description: 'compare E2E test',
  18 |       options: { vus: 1, duration: '10s' },
  19 |     },
  20 |   });
  21 |   const { test: created } = await res.json();
  22 |   const testId: string = created.id;
  23 | 
  24 |   // Poll until completed or failed (max 3 minutes)
  25 |   const deadline = Date.now() + 180_000;
  26 |   while (Date.now() < deadline) {
  27 |     const r = await page.request.get(`${RESULTS_URL}/results/${testId}`);
  28 |     const { result } = await r.json();
  29 |     if (result?.status === 'completed' || result?.status === 'failed') break;
  30 |     await page.waitForTimeout(3000);
  31 |   }
  32 | 
  33 |   return testId;
  34 | }
  35 | 
  36 | test.describe('Compare flow', () => {
  37 |   test('selects two results and opens the compare view', async ({ page }) => {
  38 |     // Create two completed tests sequentially
  39 |     const [idA, idB] = await Promise.all([
  40 |       createAndWaitForResult(page),
  41 |       createAndWaitForResult(page),
  42 |     ]);
  43 | 
  44 |     // Navigate to results list
  45 |     await page.goto('/results');
  46 |     await page.waitForLoadState('networkidle');
  47 | 
  48 |     // Both tests should appear in the list (use first() — results page may have multiple links per row)
  49 |     await expect(page.locator(`a[href="/results/${idA}"]`).first()).toBeVisible({ timeout: 15_000 });
  50 |     await expect(page.locator(`a[href="/results/${idB}"]`).first()).toBeVisible({ timeout: 5_000 });
  51 | 
  52 |     // Select both via checkboxes (table row containing the testId link)
  53 |     const rowA = page.locator(`tr:has(a[href="/results/${idA}"])`).first();
  54 |     const rowB = page.locator(`tr:has(a[href="/results/${idB}"])`).first();
  55 | 
> 56 |     await rowA.locator('input[type="checkbox"]').click();
     |                                                  ^ Error: locator.click: Test timeout of 300000ms exceeded.
  57 |     await rowB.locator('input[type="checkbox"]').click();
  58 | 
  59 |     // Compare button should appear
  60 |     const compareBtn = page.getByRole('button', { name: /compare selected/i });
  61 |     await expect(compareBtn).toBeVisible({ timeout: 5_000 });
  62 |     await compareBtn.click();
  63 | 
  64 |     // Should navigate to compare page with both IDs
  65 |     await expect(page).toHaveURL(/\/results\/compare\?a=.+&b=.+/, { timeout: 10_000 });
  66 | 
  67 |     // The compare page should show metrics for both results
  68 |     await expect(page.getByText(/result a/i)).toBeVisible({ timeout: 10_000 });
  69 |     await expect(page.getByText(/result b/i)).toBeVisible({ timeout: 5_000 });
  70 |   });
  71 | });
  72 | 
```