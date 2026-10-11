# Center_HUB

หน้าเว็บกลางสำหรับจัดการทุก project บนทุกเครื่อง (DelayHUB, Chem_RecHUB, Chem_IssueHUB, Chem_IdentifyHUB, QR_Code_Ink_Code_HUB …) จากที่เดียว ใช้หลักเดียวกับ Docker Hub แต่ทำงานบน **PM2** ที่มีอยู่แล้ว

| ทำอะไรได้ | รายละเอียด |
|---|---|
| สถานะ project | RUN / บางส่วน / DOWN ต่อ app, CPU, RAM, จำนวน restart, uptime, health URL — รีเฟรชทุก 5 วินาที |
| สั่ง PM2 | Start / Stop / Reload / Restart ทั้ง project หรือทีละ app (start ใช้ ecosystem ของ project เอง) |
| ดู log | stdout / stderr ท้ายไฟล์ อัปเดตอัตโนมัติ (ปิดรหัสผ่าน/token ก่อนแสดง) |
| ตรวจพอร์ต | เทียบพอร์ตที่ประกาศกับที่เปิดจริง (netstat): ประกาศซ้ำ, ถูกโปรแกรมอื่นยึด, ชนพอร์ตสงวน (SQL 1433, Redis 6379, RDP 3389 …), app online แต่ไม่เปิดพอร์ต, พอร์ตที่ PM2 เปิดแต่ลืมประกาศ |
| Git | timeline แบบกราฟ (ทุก branch), รายการ branch + checkout, fetch, pull (`--ff-only`), ไฟล์ที่แก้ค้าง + diff, commit เฉพาะไฟล์ที่เลือก (+ push) |
| Deploy | ปุ่มเดียว: ตรวจไฟล์ค้าง/พอร์ต → fetch → pull → `npm ci` (เฉพาะเมื่อ lockfile เปลี่ยน) → build → test → `pm2 reload` → ตรวจ health 3 รอบ → **พังแล้ว rollback กลับ commit เดิมอัตโนมัติ** |
| Auto deploy | ต่อ project: `manual` (กดเอง) · `notify` (แจ้ง LINE เมื่อมีโค้ดใหม่) · `schedule` (เช่น ทุกวันอาทิตย์ 03:00) · `immediate` (pull + deploy ทันทีที่มีโค้ดใหม่) + ช่วงห้าม deploy (freeze) เช่น จันทร์–เสาร์ 06:00–20:00 + Force deploy เมื่อจำเป็น |
| Load Balancer | ตั้ง site + เครื่องปลายทางในหน้าเว็บครั้งเดียว Hub สร้าง config nginx (ip_hash สำหรับ Socket.IO, ถอดเครื่องชั่วคราวได้) แล้วติดตั้งที่เครื่อง LB ให้ (`nginx -t` ก่อน reload, ไม่ผ่านคืนไฟล์เดิม) |
| ผู้ใช้ / ประวัติ | 3 ระดับสิทธิ์ (viewer / operator / admin), ล็อกหลังรหัสผิด 5 ครั้ง, บันทึกทุกการสั่งงาน (ใคร/อะไร/เมื่อไร/ผล) |

## โครงสร้าง

```
          เบราว์เซอร์ (admin / operator / viewer)
                       │  https://<hub>:4900  (login + cookie)
                       ▼
               ┌──────────────┐
               │  Center Hub  │  hub/  — หน้าเว็บ + ผู้ใช้ + audit + สร้าง config LB
               └──────┬───────┘
          คำสั่งลงลายเซ็น HMAC (X-Center-Ts / X-Center-Sig, ±60 วิ, ใช้ซ้ำไม่ได้)
          ┌───────────┼─────────────────────┐
          ▼           ▼                     ▼
   ┌────────────┐ ┌────────────┐     ┌────────────┐
   │ Agent 116  │ │ Agent 117  │     │ Agent LB   │   agent/ — 1 ตัวต่อเครื่อง :4910
   │ PM2 · git  │ │ PM2 · git  │     │ nginx      │   คุม PM2 ตัวเดียวกับ project
   └────────────┘ └────────────┘     └────────────┘
```

- **Hub** (`hub/`) ไม่มี dependency เลย (Node ล้วน) เก็บข้อมูลเป็นไฟล์ JSON ใน `hub/data/`
- **Agent** (`agent/`) ใช้ package เดียวคือ `pm2` (คุม daemon ตัวเดียวกับคำสั่ง `pm2` ใน cmd) รันคำสั่งภายนอกแบบไม่ผ่าน shell ทั้งหมด
- Agent รับเฉพาะคำสั่งที่ Hub ลงลายเซ็น — ความลับของแต่ละเครื่องอยู่ใน `agent/.env` และ `hub/data/agents.json` เท่านั้น ไม่เคยส่งไปหน้าเว็บ

## ติดตั้ง (Windows Server)

ต้องมี Node.js 18+ , git และ PM2 แบบเดียวกับ project อื่น

### 1. Agent — ทุกเครื่องที่มี project (เช่น 116 และเครื่องที่สอง)

```bat
cd /d I:\
git clone https://github.com/TUAPUAN-CODE/Center_HUB.git
cd Center_HUB\agent
npm ci --omit=dev

copy .env.example .env
copy config\agent.example.json config\agent.json
copy config\projects.example.json config\projects.json
```

1. สร้างความลับ: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` แล้วใส่ใน `agent\.env` ที่ `CENTER_AGENT_SECRET=` (**แต่ละเครื่องใช้ค่าต่างกัน**)
2. ใส่ IP ของเครื่อง Hub ที่ `CENTER_AGENT_ALLOW_IPS=` (เช่น `172.48.0.116`)
3. แก้ `config\agent.json` (`id`, `name`) และ `config\projects.json` ให้ตรงเครื่อง — ชื่อ app ต้องตรงกับ `pm2 list`, `repoDir` เป็น path จริง (แก้ภายหลังผ่านหน้าเว็บได้: ตั้งค่า → Project)
4. เปิด firewall พอร์ต 4910 **เฉพาะจาก IP ของ Hub**
5. รัน (ใช้ Windows user เดียวกับที่รัน PM2 ของ project อื่น — ถ้า PM2 ใช้ `PM2_HOME` พิเศษ ต้องตั้งค่าเดียวกัน):

```bat
pm2 start ecosystem.config.js
pm2 save
```

ตรวจ: `curl http://127.0.0.1:4910/health` → `{"ok":true,...}`

### 2. Hub — เครื่องเดียว (เช่น 116)

```bat
cd /d I:\Center_HUB\hub
copy .env.example .env
node scripts\user.js admin admin
pm2 start ecosystem.config.js
pm2 save
```

เปิด `http://<ip-ของ-hub>:4900` → login → **ตั้งค่า → เครื่อง (Agent)** เพิ่มทีละเครื่อง (id, URL `http://172.48.0.116:4910`, ความลับเดียวกับ `agent\.env` ของเครื่องนั้น)

> แนะนำเปิด HTTPS: ใส่ `CENTER_HUB_TLS_CERT` / `CENTER_HUB_TLS_KEY` ใน `hub\.env` (cookie จะเป็น Secure อัตโนมัติ) และเปิดพอร์ต 4900 เฉพาะเครือข่าย admin

### 3. Load Balancer (ถ้าใช้ 2 เครื่อง)

1. ติดตั้ง nginx for Windows บนเครื่อง LB (เช่น `C:\nginx`) และ Agent ตามข้อ 1
2. ใน `C:\nginx\conf\nginx.conf` บล็อก `http { … }` เพิ่มบรรทัด `include center_hub.conf;`
3. ใช้ `config\agent.lb.example.json` เป็น `config\agent.json` ของเครื่องนั้น (บอก path ของ nginx.exe และไฟล์ที่ Hub จะเขียน)
4. หน้า **Load Balancer** → เลือกเครื่อง LB → "สร้างจาก project" (เติมเครื่องปลายทางทุกเครื่องที่มี project นั้นให้) → ตั้งพอร์ตที่ LB ฟัง → **บันทึก + ติดตั้งที่เครื่อง LB**

ข้อควรรู้: DelayHUB ต้องใช้ `ip_hash` (Socket.IO) และต้องมี Redis กลาง + leader lock ตาม `backend/HA_RUNBOOK.md` ของ DelayHUB ก่อนเปิดสองเครื่องจริง; พอร์ตที่ LB ฟังห้ามชนกับ app บนเครื่อง LB (Hub ตรวจให้ก่อนติดตั้ง); ถ้าจะซ่อม/deploy เครื่องไหน ติ๊ก "ปิดชั่วคราว" ของเครื่องนั้นแล้วติดตั้ง config ก่อน

## ตั้งค่า project (`agent/config/projects.json`)

```jsonc
{
  "id": "delayhub",                       // a-z 0-9 -
  "name": "DelayHUB (PFCM)",
  "repoDir": "I:\\test\\DelayHUB",        // path บนเครื่องนี้
  "branch": "main", "remote": "origin",
  "ecosystem": "backend/ecosystem.config.js", // ใช้ตอน Start (รันจากโฟลเดอร์ของไฟล์นี้ เหมือนพิมพ์ pm2 start เอง)
  "apps": ["PFCMv2-backend", "PFCMv2-frontend", "rfidc1-service"], // ชื่อใน pm2 list
  "singleton": ["rfidc1-service"],        // ใช้ restart แทน reload (ห้ามมี 2 ตัวพร้อมกัน)
  "ports": [3000, 80],
  "health": [{ "url": "http://127.0.0.1:3000/health" }],
  "deploy": {
    "mode": "schedule",                   // manual | notify | schedule | immediate
    "days": [0], "time": "03:00",         // 0 = อาทิตย์ … 6 = เสาร์ (เวลาเครื่อง)
    "freeze": [{ "days": [1,2,3,4,5,6], "from": "06:00", "to": "20:00" }],
    "install": [{ "cwd": "backend", "cmd": ["npm", "ci", "--omit=dev"] }],  // รันเมื่อ package(-lock).json ในโฟลเดอร์นั้นเปลี่ยน
    "build":   [{ "cwd": "frontend", "cmd": ["npm", "run", "build"], "timeoutMin": 20 }],
    "test":    [],
    "reload": "reload",                   // reload | restart
    "rollback": true,
    "healthTimeoutSec": 90
  }
}
```

- คำสั่งใน install/build/test ใช้ได้เฉพาะ `npm` และ `node` (เพิ่มได้ที่ `allowedCommands` ใน `agent.json` บนเครื่องเท่านั้น — Hub เพิ่มให้ไม่ได้)
- Agent ตรวจ remote ทุก `fetchIntervalMin` นาที (ค่าเริ่ม 5); โหมด `schedule` มีช่วงผ่อนผัน `scheduleWindowMin` (60 นาที) เผื่อเครื่องปิดตอนถึงเวลา
- แจ้ง LINE: ใส่ `LINE_CHANNEL_ACCESS_TOKEN` และ `LINE_NOTIFY_TO` ใน `agent\.env`

## กฎความปลอดภัยของ deploy (ทำไมบางครั้งไม่ยอม deploy)

- **มีไฟล์แก้ค้างบนเครื่อง** → ไม่ deploy (กันโค้ดที่แก้บน server หาย) — commit ผ่านหน้า Git หรือย้ายไปไว้ใน repo ก่อน; ไฟล์ที่ build สร้างใหม่ทุกครั้งแต่ถูก track ไว้ ใส่ใน `restorePaths`
- **ไม่ได้อยู่ branch ที่ตั้งไว้** → ไม่ deploy
- **pull ได้แบบ fast-forward เท่านั้น** — ถ้าบน server มี commit ที่ remote ไม่มี ต้อง push ขึ้นก่อน
- **อยู่ในช่วง freeze / พอร์ตชน** → ไม่ deploy ยกเว้น Force deploy (admin)
- Windows ล็อกไฟล์ที่ node ใช้อยู่ → ถ้าต้อง `npm ci` Agent จะหยุด app ก่อนติดตั้ง (มี downtime เฉพาะรอบที่ dependency เปลี่ยน); รอบปกติใช้ `pm2 reload`
- rollback = `git reset --hard <commit เดิม>` + ติดตั้ง/build ใหม่ + reload — ใช้ได้เพราะเช็กแล้วว่าไม่มีไฟล์แก้ค้าง (`.env` และไฟล์ที่ไม่ได้ track ไม่ถูกแตะ)

## สิทธิ์ผู้ใช้

| | viewer | operator | admin |
|---|:-:|:-:|:-:|
| ภาพรวม / พอร์ต / git timeline / ประวัติ deploy | ✓ | ✓ | ✓ |
| Start / Stop / Reload / Restart, ดู log, diff, fetch, pull, Deploy ปกติ | | ✓ | ✓ |
| Commit, Checkout, Force deploy, Rebuild, ตั้งค่า project, เครื่อง, ผู้ใช้, Load Balancer, ประวัติการสั่งงาน | | | ✓ |

ลืมรหัส admin: `node hub\scripts\user.js <ชื่อ> admin` บนเครื่อง Hub (ไม่ต้อง restart)

## ทดสอบ

```bash
cd agent && npm ci && cd ..
npm test
```

- `tests/unit.test.js` — ลายเซ็น, แยก netstat/ss/tasklist + หาพอร์ตชน, ตารางเวลา/freeze, ตรวจ projects.json, ปิดความลับ, template nginx, ผู้ใช้/ล็อก
- `tests/integration.test.js` — Hub + Agent + PM2 จริง (daemon ชั่วคราว) + git remote ชั่วคราว: login/สิทธิ์/CSRF, start/stop, ตรวจพอร์ต, log ปิดความลับ, deploy สำเร็จ, deploy โค้ดพัง → rollback, ไฟล์ค้าง → ไม่ deploy, commit (ห้าม `.env`), ตั้งค่าผิดไม่ถูกบันทึก, audit

## ข้อจำกัดที่ควรรู้

- session ของ Hub อยู่ในหน่วยความจำ → restart Hub แล้วทุกคนต้อง login ใหม่ (Hub ต้องเป็น fork 1 ตัว)
- build frontend ทับโฟลเดอร์ `dist` เดิม → ระหว่าง build ไม่กี่วินาทีหน้าเว็บอาจโหลดไฟล์ไม่ครบ
- git บนเครื่องต้องเก็บ credential ไว้แล้ว (Git Credential Manager ของ Windows user ที่รัน Agent) — ถ้าไม่มี fetch จะล้มทันทีและแสดงใน card (ไม่ค้างรอพิมพ์รหัส)
- Agent สั่งได้เฉพาะ app ที่ประกาศใน `projects.json` และห้ามสั่ง `center-agent` ตัวเอง
