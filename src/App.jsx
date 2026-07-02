import { useState, useRef, useCallback, useEffect } from "react";

/* ── Gemini API ───────────────────────────────────────── */
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
const BUNDLED_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";
const SAVES_KEY = "schedule_saves_v1";
const LEGACY_KEY = "schedule_saved_data";

async function callAPI(base64, mediaType, prompt, apiKey, maxTokens = 2000, jsonSchema = null) {
  const generationConfig = { maxOutputTokens: maxTokens, temperature: 0 };
  if (jsonSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = jsonSchema;
  }
  const res = await fetch(GEMINI_URL(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mediaType, data: base64 } },
        { text: prompt },
      ]}],
      generationConfig,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `API 오류 (HTTP ${res.status})`);
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
}

// 토큰 초과로 JSON이 잘렸을 때 완성된 항목까지 복구
function safeParseJson(raw) {
  try { return JSON.parse(raw); } catch {}
  const lastClose = raw.lastIndexOf('},');
  if (lastClose < 0) return null;
  const partial = raw.slice(0, lastClose + 1);
  for (const tail of [']}', '\n]}', '\n  ]\n}', '  ]\n}']) {
    try { return JSON.parse(partial + tail); } catch {}
  }
  return null;
}

/* ── 유틸 ────────────────────────────────────────────── */
function getMediaType(file) {
  const t = file.type;
  if (["image/jpeg","image/png","image/webp","image/gif"].includes(t)) return t;
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/jpeg";
}

const PROMPT_HOSPITAL = `이 이미지는 병원 외래 스케줄 표입니다.
이미지에서 병원명(병원 이름)을 찾아서 정확히 출력하세요.
병원명만 한 줄로 출력하고, 다른 설명이나 문장은 일절 출력하지 마세요.
병원명을 헤더, 로고 주변 텍스트에서 찾으세요.
찾을 수 없다면 아무것도 출력하지 마세요.`;

/* JSON Schema로 출력 구조 강제 → hallucination 구조적 차단 */
const DOCTORS_SCHEMA = {
  type: "OBJECT",
  properties: {
    doctors: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name:       { type: "STRING" },
          department: { type: "STRING" },
          schedule: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                day:    { type: "STRING", enum: ["월","화","수","목","금","토","일"] },
                period: { type: "STRING", enum: ["오전","오후"] },
              },
              required: ["day","period"],
            },
          },
          room:  { type: "STRING" },
          notes: { type: "STRING" },
        },
        required: ["name","department","schedule"],
      },
    },
  },
  required: ["doctors"],
};

const PROMPT_ALL_DOCTORS = `이 이미지는 병원 외래 스케줄 표입니다.
이미지에 보이는 모든 의사의 정보를 추출하세요.

⚠️ 반드시 지켜야 할 규칙:
• 이미지에서 직접 읽은 정보만 출력하세요 (병원 지식·추측 완전 금지)
• 이미지에 있는 모든 의사를 빠짐없이 추출하세요 (한 명도 빠뜨리지 마세요)
• 의사 이름을 이미지에서 한 글자씩 정확히 읽으세요
  예) 현 vs 원 (초성 ㅎ vs ㅇ), 성 vs 생 (종성 유무), 환 vs 관
• 진료과는 이미지에 표시된 그대로 입력하세요 (없는 진료과 절대 추가 금지)
• schedule에는 외래 진료가 실제로 있는 요일/시간대만 포함하세요
• 진료 없는 날/시간대는 schedule에서 제외하세요`;

const XLS_DAYS = ["월","화","수","목","금","토"];
const XLS_SLOTS = XLS_DAYS.flatMap(d => [`${d}오전`, `${d}오후`]);

/* ── PDF 보고서 스타일 (새 탭 인쇄용) ─────────────── */
const REPORT_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Pretendard','맑은 고딕','Malgun Gothic',-apple-system,sans-serif; color: #1a1a1a; background: #eceff1; padding: 24px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { max-width: 1120px; margin: 0 auto; background: #fff; padding: 32px 36px; border-radius: 8px; box-shadow: 0 2px 20px rgba(0,0,0,0.08); }
.rpt-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #0D8A99; padding-bottom: 14px; margin-bottom: 22px; }
.rpt-title { font-size: 26px; font-weight: 800; color: #0A5D6E; letter-spacing: -0.5px; }
.rpt-sub { font-size: 13px; color: #888; margin-top: 3px; }
.rpt-meta { text-align: right; font-size: 12px; color: #666; line-height: 1.7; }
.rpt-filter { margin-top: 2px; color: #0D8A99; font-weight: 600; }
.sec { margin-bottom: 26px; }
.sec-title { font-size: 14px; font-weight: 700; color: #0A5D6E; margin-bottom: 10px; padding-left: 9px; border-left: 4px solid #2CC0D0; }
table.cal { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.cal th, table.cal td { border: 1px solid #d8e6e9; }
.corner { width: 54px; background: #f4f8f9; }
.dayhead { background: #0D8A99; color: #fff; font-size: 14px; font-weight: 700; padding: 9px 0; text-align: center; }
.period { width: 54px; text-align: center; font-weight: 700; font-size: 13px; }
.period.am { background: #E5F7FA; color: #076478; }
.period.pm { background: #FEF4E2; color: #7a4a05; }
td.cell { vertical-align: top; padding: 6px; height: 88px; }
.doc { border-radius: 6px; padding: 4px 7px; margin-bottom: 4px; }
.doc.am { background: #D9F4F7; border: 1px solid #8AD7E0; }
.doc.pm { background: #FAEEDA; border: 1px solid #F1CB8A; }
.doc .dn { display: block; font-size: 12.5px; font-weight: 700; color: #111; }
.doc .dd { display: block; font-size: 10px; color: #777; margin-top: 1px; }
.empty { display: block; text-align: center; color: #ccc; padding-top: 8px; }
table.list { width: 100%; border-collapse: collapse; }
table.list th { background: #0A5D6E; color: #fff; font-size: 12px; font-weight: 600; padding: 8px 10px; text-align: left; }
table.list td { padding: 7px 10px; border-bottom: 1px solid #eee; font-size: 12px; vertical-align: top; }
table.list tr.odd td { background: #F7FCFD; }
.c-name { font-weight: 700; color: #111; white-space: nowrap; }
.dept { display: inline-block; background: #eef4f5; border: 1px solid #d3e3e6; border-radius: 4px; padding: 1px 7px; font-size: 11px; color: #4a6b70; }
.pill { display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 10.5px; margin: 1px; }
.pill.am { background: #D9F4F7; color: #076478; border: 1px solid #8AD7E0; }
.pill.pm { background: #FAEEDA; color: #7a4a05; border: 1px solid #F1CB8A; }
.c-room { font-family: monospace; color: #555; }
.c-note { color: #777; }
.muted { color: #bbb; }
.rpt-foot { margin-top: 24px; text-align: center; font-size: 10px; color: #bbb; letter-spacing: 0.05em; }
@media print {
  body { background: #fff; padding: 0; }
  .page { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
  table.list tr, .doc { page-break-inside: avoid; }
  thead { display: table-header-group; }
}
@page { size: A4 landscape; margin: 12mm; }
`;

/* ── 진료과 드롭다운 ─────────────────────────────── */
function DeptDropdown({ allDepts, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  const toggle = (d) => onChange(selected.includes(d) ? selected.filter(x => x !== d) : [...selected, d]);
  const label = selected.length === 0 ? "전체 진료과" : `진료과 ${selected.length}개선택`;
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} style={{ padding: "6px 10px", fontSize: 13, border: "0.5px solid #ddd", borderRadius: 8, background: selected.length ? "#D9F4F7" : "#f9f9f9", color: selected.length ? "#076478" : "#222", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
        {label} <span style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, background: "#fff", border: "0.5px solid #ddd", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.1)", zIndex: 200, minWidth: 160, maxHeight: 260, overflowY: "auto", padding: "4px 0" }}>
          {selected.length > 0 && (
            <button onClick={() => onChange([])} style={{ width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 12, color: "#0D8A99", background: "none", border: "none", borderBottom: "0.5px solid #f0f0f0", cursor: "pointer", fontWeight: 500 }}>✕ 선택 해제</button>
          )}
          {allDepts.map(d => (
            <label key={d} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13, color: selected.includes(d) ? "#076478" : "#333", background: selected.includes(d) ? "#E5F7FA" : "transparent" }}>
              <input type="checkbox" checked={selected.includes(d)} onChange={() => toggle(d)} style={{ accentColor: "#0D8A99", flexShrink: 0 }} />
              {d}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 요일별 그리드 ──────────────────────────────── */
const ALL_DAYS = ["월", "화", "수", "목", "금", "토"];

// 진료과 구분용 범주형 팔레트 (고정 순서 — 데이터셋 전체 진료과 목록 기준 인덱싱)
const DEPT_PALETTE = [
  { bg: "#E1ECF9", text: "#1B4E8B", border: "#9FC2ED" }, // blue
  { bg: "#DFF4EC", text: "#12724F", border: "#98DBC3" }, // aqua
  { bg: "#FCF2DB", text: "#9A6900", border: "#F7D58C" }, // yellow
  { bg: "#DBEEDB", text: "#005500", border: "#8CC78C" }, // green
  { bg: "#E6E3F3", text: "#30266D", border: "#AEA6D7" }, // violet
  { bg: "#FBE6E5", text: "#942F2F", border: "#F2ADAD" }, // red
  { bg: "#FCEDF2", text: "#97506B", border: "#F5C4D6" }, // magenta
  { bg: "#FCEAE3", text: "#994422", border: "#F6BBA4" }, // orange
];
function deptColor(dept, allDepts) {
  const idx = allDepts.indexOf(dept);
  return DEPT_PALETTE[(idx < 0 ? 0 : idx) % DEPT_PALETTE.length];
}

function DayView({ doctors, search, deptFilters, dayFilters, allDepts }) {
  const activeDays = dayFilters.length > 0 ? ALL_DAYS.filter(d => dayFilters.includes(d)) : ALL_DAYS;
  const multiDept = deptFilters.length > 1;
  const filtered = doctors.filter(d => {
    const q = search.toLowerCase();
    return (!q || (d.name||"").toLowerCase().includes(q) || (d.department||"").toLowerCase().includes(q))
      && (deptFilters.length === 0 || deptFilters.includes(d.department));
  });
  const matrix = {};
  activeDays.forEach(day => { matrix[`${day}_AM`] = []; matrix[`${day}_PM`] = []; });
  filtered.forEach(doc => {
    (doc.schedule || []).forEach(sc => {
      const key = `${sc.day}_${sc.period}`;
      if (matrix[key] && !matrix[key].find(x => x.name === doc.name && x.department === doc.department))
        matrix[key].push(doc);
    });
  });
  const hasAny = activeDays.some(d => matrix[`${d}_AM`].length || matrix[`${d}_PM`].length);
  if (!hasAny) return <div style={{ padding: "2rem", textAlign: "center", color: "#bbb", fontSize: 13 }}>표시할 일정이 없습니다</div>;
  return (
    <div>
      {multiDept && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "10px 4px 4px" }}>
          {deptFilters.map(dep => {
            const c = deptColor(dep, allDepts);
            return (
              <span key={dep} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: c.bg, color: c.text, border: `0.5px solid ${c.border}` }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.text, flexShrink: 0 }} />
                {dep}
              </span>
            );
          })}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: activeDays.length * 110 }}>
          <colgroup><col style={{ width: 52 }} />{activeDays.map(d => <col key={d} />)}</colgroup>
          <thead>
            <tr>
              <th style={{ padding: "8px 6px", background: "#f9f9f9", borderBottom: "0.5px solid #ddd", fontSize: 11, color: "#bbb" }} />
              {activeDays.map(day => (
                <th key={day} style={{ padding: "9px 8px", background: "#f9f9f9", borderBottom: "0.5px solid #ddd", borderLeft: "0.5px solid #f0f0f0", fontSize: 12, fontWeight: 600, color: "#444", textAlign: "center" }}>
                  {day}요일
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {["AM", "PM"].map(period => (
              <tr key={period} style={{ verticalAlign: "top" }}>
                <td style={{ padding: "10px 4px", textAlign: "center", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", borderBottom: "0.5px solid #eee", borderRight: "0.5px solid #ddd", color: period === "AM" ? "#076478" : "#633806", background: period === "AM" ? "#E5F7FA" : "#fef9f0" }}>
                  {period === "AM" ? "오전" : "오후"}
                </td>
                {activeDays.map(day => {
                  const list = matrix[`${day}_${period}`];
                  return (
                    <td key={day} style={{ padding: "6px 8px", verticalAlign: "top", borderBottom: "0.5px solid #f0f0f0", borderLeft: "0.5px solid #f0f0f0", background: list.length ? (period === "AM" ? "#F3FCFD" : "#fffdf8") : "transparent", minWidth: 90 }}>
                      {list.length === 0
                        ? <span style={{ color: "#e0e0e0", fontSize: 12, display: "block", textAlign: "center", paddingTop: 6 }}>—</span>
                        : list.map((d, i) => {
                          const c = multiDept ? deptColor(d.department, allDepts) : null;
                          const bg = c ? c.bg : (period === "AM" ? "#D9F4F7" : "#FAEEDA");
                          const border = c ? c.border : (period === "AM" ? "#77CED9" : "#FAC775");
                          return (
                            <div key={i} style={{ marginBottom: 4, padding: "4px 6px", borderRadius: 6, background: bg, border: `0.5px solid ${border}` }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "#111", lineHeight: 1.3 }}>{d.name}</div>
                              <div style={{ fontSize: 10, color: c ? c.text : "#888", fontWeight: c ? 600 : 400, marginTop: 1 }}>{d.department}{d.room ? ` · ${d.room}호` : ""}</div>
                            </div>
                          );
                        })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── App ──────────────────────────────────────────────── */
export default function App() {
  const [apiKey, setApiKey] = useState(() => BUNDLED_API_KEY || localStorage.getItem("gemini_api_key") || "");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKeySetup, setShowApiKeySetup] = useState(!BUNDLED_API_KEY && !localStorage.getItem("gemini_api_key"));

  const [images, setImages] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const idRef = useRef(0);
  const fileRef = useRef();

  const [stage, setStage] = useState("upload");
  const [progress, setProgress] = useState({ imgCurrent: 0, imgTotal: 0, label: "" });
  const [doctors, setDoctors] = useState([]);
  const [hospitalName, setHospitalName] = useState("");
  const [editingHospital, setEditingHospital] = useState(false);
  const hospitalInputRef = useRef();
  const [rawLogs, setRawLogs] = useState([]);
  const [showRaw, setShowRaw] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const [viewMode, setViewMode] = useState("table");
  const [search, setSearch] = useState("");
  const [deptFilters, setDeptFilters] = useState([]);
  const [dayFilters, setDayFilters] = useState([]);
  const [copied, setCopied] = useState(false);
  const [savedToast, setSavedToast] = useState(false);

  const [saves, setSaves] = useState(() => {
    try {
      const raw = localStorage.getItem(SAVES_KEY);
      if (raw) return JSON.parse(raw);
      const legacyRaw = localStorage.getItem(LEGACY_KEY);
      if (legacyRaw) {
        const old = JSON.parse(legacyRaw);
        if (old.doctors?.length) {
          const migrated = [{ id: Date.now(), hospitalName: old.hospitalName || "", doctors: old.doctors, savedAt: old.savedAt || new Date().toISOString(), count: old.count || old.doctors.length }];
          localStorage.setItem(SAVES_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
      return [];
    } catch { return []; }
  });

  const [editingDoctor, setEditingDoctor] = useState(null);
  const doctorEditRef = useRef();
  useEffect(() => { if (editingDoctor) doctorEditRef.current?.focus(); }, [editingDoctor]);
  useEffect(() => { if (editingHospital) hospitalInputRef.current?.focus(); }, [editingHospital]);

  const startEditDoctor = (doc) =>
    setEditingDoctor({ name: doc.name, department: doc.department, tempName: doc.name || "" });

  const commitEditDoctor = () => {
    if (!editingDoctor) return;
    const newName = editingDoctor.tempName.trim();
    if (newName) {
      setDoctors(prev => prev.map(d =>
        d.name === editingDoctor.name && d.department === editingDoctor.department
          ? { ...d, name: newName } : d
      ));
    }
    setEditingDoctor(null);
  };

  const saveApiKey = () => {
    const key = apiKeyInput.trim();
    if (!key.startsWith("AIza")) { alert("올바른 Gemini API 키를 입력하세요 (AIza로 시작)"); return; }
    localStorage.setItem("gemini_api_key", key);
    setApiKey(key); setShowApiKeySetup(false); setApiKeyInput("");
  };

  const addFiles = useCallback((files) => {
    Array.from(files).filter(f => f.type.startsWith("image/")).forEach(file => {
      const mt = getMediaType(file);
      const reader = new FileReader();
      reader.onload = (e) => {
        idRef.current += 1;
        setImages(prev => [...prev, { id: idRef.current, src: e.target.result, base64: e.target.result.split(",")[1], mediaType: mt, fileName: file.name, fileSize: (file.size / 1024).toFixed(1) + " KB" }]);
        setStage(s => s === "upload" ? "preview" : s);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const removeImage = (id) => {
    setImages(prev => { const next = prev.filter(i => i.id !== id); if (!next.length) setStage("upload"); return next; });
  };

  const reset = () => {
    setStage("upload"); setImages([]); setDoctors([]);
    setHospitalName(""); setEditingHospital(false); setEditingDoctor(null);
    setSearch(""); setDeptFilters([]); setDayFilters([]);
    setShowRaw(false); setErrorMsg(""); setRawLogs([]);
    setViewMode("table");
    if (fileRef.current) fileRef.current.value = "";
  };

  const saveToLocal = () => {
    const entry = { id: Date.now(), hospitalName, doctors, savedAt: new Date().toISOString(), count: doctors.length };
    const existingIdx = saves.findIndex(s => s.hospitalName && s.hospitalName === hospitalName && hospitalName !== "");
    const next = existingIdx >= 0
      ? saves.map((s, i) => i === existingIdx ? entry : s)
      : [entry, ...saves].slice(0, 10);
    localStorage.setItem(SAVES_KEY, JSON.stringify(next));
    setSaves(next);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 1500);
  };

  const loadFromSaved = (entry) => { setDoctors(entry.doctors); setHospitalName(entry.hospitalName || ""); setStage("results"); };

  const deleteSaved = (id) => {
    const next = saves.filter(s => s.id !== id);
    localStorage.setItem(SAVES_KEY, JSON.stringify(next));
    setSaves(next);
  };

  // HTML-based XLS: Excel이 읽을 수 있는 HTML 형식으로 배경색 포함
  const downloadXLS = () => {
    const esc = (v) => String(v || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const th = (txt, bg, color, center = true) =>
      `<th style="background:${bg};color:${color};font-weight:bold;text-align:${center?'center':'left'};border:1px solid #bbb;padding:6px 10px;font-size:12px;white-space:nowrap;">${esc(txt)}</th>`;
    const td = (txt, bg, color, center = false, bold = false) =>
      `<td style="background:${bg};color:${color};text-align:${center?'center':'left'};border:1px solid #e0e0e0;padding:5px 9px;font-size:12px;${bold?'font-weight:600;':''}">${esc(txt)}</td>`;

    const headerRow = [
      th("의사명",   "#EEF8FA", "#0A5D6E", false),
      th("진료과",   "#EEF8FA", "#0A5D6E", false),
      ...XLS_SLOTS.map(slot => {
        const am = slot.endsWith("오전");
        return th(slot, am ? "#C5EDF3" : "#FAE8C8", am ? "#065566" : "#5A3000");
      }),
      th("진료실", "#EEF8FA", "#0A5D6E"),
      th("비고",   "#EEF8FA", "#0A5D6E", false),
    ].join("");

    const dataRows = doctors.map((d, ri) => {
      const has = new Set((d.schedule||[]).map(s => s.day + (s.period==="PM"?"오후":"오전")));
      const rowBg = ri % 2 === 0 ? "#ffffff" : "#F7FCFD";
      const cells = [
        td(d.name||"",       rowBg, "#111", false, true),
        td(d.department||"", rowBg, "#444"),
        ...XLS_SLOTS.map(slot => {
          const am = slot.endsWith("오전");
          return has.has(slot)
            ? td("●", am ? "#D9F4F7" : "#FAEEDA", am ? "#065566" : "#5A3000", true, true)
            : td("",  rowBg,   "#ddd", true);
        }),
        td(d.room||"",  rowBg, "#555", true),
        td(d.notes||"", rowBg, "#666"),
      ].join("");
      return `<tr>${cells}</tr>`;
    }).join("");

    const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="UTF-8">
<style>table{border-collapse:collapse;font-family:'맑은 고딕',Arial,sans-serif;}</style>
</head><body>
<table>
<thead><tr>${headerRow}</tr></thead>
<tbody>${dataRows}</tbody>
</table></body></html>`;

    const blob = new Blob(["﻿" + html], { type: "application/vnd.ms-excel;charset=UTF-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `외래스케줄${hospitalName ? `_${hospitalName}` : ""}_${new Date().toISOString().slice(0,10)}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // C안: 주간 달력 + 의사 목록표를 인쇄용 HTML 보고서로 새 탭에 출력 (PDF 저장 유도)
  const openReport = () => {
    const esc = (v) => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const list = filtered;
    if (!list.length) { alert("출력할 데이터가 없습니다."); return; }

    const days = dayFilters.length > 0 ? ALL_DAYS.filter(d => dayFilters.includes(d)) : ALL_DAYS;
    const matrix = {};
    days.forEach(day => { matrix[day + "_AM"] = []; matrix[day + "_PM"] = []; });
    list.forEach(doc => {
      (doc.schedule || []).forEach(sc => {
        const key = sc.day + "_" + sc.period;
        if (matrix[key] && !matrix[key].find(x => x.name === doc.name && x.department === doc.department))
          matrix[key].push(doc);
      });
    });

    const calHead = "<tr><th class='corner'></th>" + days.map(d => "<th class='dayhead'>" + esc(d) + "요일</th>").join("") + "</tr>";
    const calBody = ["AM","PM"].map(period => {
      const cells = days.map(day => {
        const cell = matrix[day + "_" + period];
        const inner = cell.length
          ? cell.map(d => "<div class='doc " + (period==="AM"?"am":"pm") + "'><span class='dn'>" + esc(d.name) + "</span><span class='dd'>" + esc(d.department) + (d.room ? " · " + esc(d.room) + "호" : "") + "</span></div>").join("")
          : "<span class='empty'>—</span>";
        return "<td class='cell'>" + inner + "</td>";
      }).join("");
      return "<tr><td class='period " + (period==="AM"?"am":"pm") + "'>" + (period==="AM"?"오전":"오후") + "</td>" + cells + "</tr>";
    }).join("");

    const listRows = list.map((d, i) => {
      const sched = (d.schedule||[]).map(sc => "<span class='pill " + (sc.period==="PM"?"pm":"am") + "'>" + esc(sc.day) + (sc.period==="PM"?"오후":"오전") + "</span>").join(" ");
      return "<tr class='" + (i%2?"odd":"") + "'><td class='c-name'>" + esc(d.name) + "</td><td><span class='dept'>" + esc(d.department) + "</span></td><td>" + (sched || "<span class='muted'>정보 없음</span>") + "</td><td class='c-room'>" + esc(d.room||"-") + "</td><td class='c-note'>" + esc(d.notes||"-") + "</td></tr>";
    }).join("");

    const filterNote = [
      deptFilters.length ? "진료과 " + deptFilters.join(", ") : null,
      dayFilters.length ? "요일 " + dayFilters.join(", ") : null,
      search ? "검색 '" + search + "'" : null,
    ].filter(Boolean).join("  ·  ");

    const today = new Date().toISOString().slice(0,10);
    const deptCount = [...new Set(list.map(d => d.department).filter(Boolean))].length;
    const title = (hospitalName || "외래 진료 일정") + " 시간표";

    const html = "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>" + esc(title) + "</title><style>" + REPORT_CSS + "</style></head><body>" +
      "<div class='page'>" +
        "<header class='rpt-head'>" +
          "<div><div class='rpt-title'>" + esc(hospitalName || "외래 진료 일정") + "</div><div class='rpt-sub'>주간 외래 진료 시간표</div></div>" +
          "<div class='rpt-meta'><div>발행일 " + today + "</div><div>" + list.length + "명 · " + deptCount + "개 진료과</div>" + (filterNote ? "<div class='rpt-filter'>" + esc(filterNote) + "</div>" : "") + "</div>" +
        "</header>" +
        "<section class='sec'><h2 class='sec-title'>주간 달력</h2><table class='cal'><thead>" + calHead + "</thead><tbody>" + calBody + "</tbody></table></section>" +
        "<section class='sec'><h2 class='sec-title'>의사 목록</h2><table class='list'><thead><tr><th>의사명</th><th>진료과</th><th>외래 일정</th><th>진료실</th><th>비고</th></tr></thead><tbody>" + listRows + "</tbody></table></section>" +
        "<footer class='rpt-foot'>🔒 Internal Use Only · Hospital TimeTable</footer>" +
      "</div>" +
      "<script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script>" +
      "</body></html>";

    const w = window.open("", "_blank");
    if (!w) { alert("팝업이 차단되어 보고서를 열 수 없습니다. 브라우저의 팝업 차단을 해제해주세요."); return; }
    w.document.write(html);
    w.document.close();
  };

  const analyze = async () => {
    setStage("analyzing"); setRawLogs([]); setHospitalName("");
    const allDoctors = [];
    try {
      setProgress({ imgCurrent: 0, imgTotal: images.length, label: "병원명 파악 중..." });
      try {
        const nameRaw = await callAPI(images[0].base64, images[0].mediaType, PROMPT_HOSPITAL, apiKey, 100);
        const extractedName = nameRaw.trim().split("\n")[0].trim();
        if (extractedName) setHospitalName(extractedName);
        setRawLogs(l => [...l, `[병원명 추출] ${extractedName || "(미확인)"}` ]);
      } catch {}

      setProgress(p => ({ ...p, label: "의사 정보 추출 중..." }));
      let done = 0;
      const CONCURRENCY = 4;
      for (let i = 0; i < images.length; i += CONCURRENCY) {
        const batch = images.slice(i, i + CONCURRENCY);
        await Promise.allSettled(batch.map(async (img, bIdx) => {
          const imgIdx = i + bIdx;
          try {
            const raw = await callAPI(img.base64, img.mediaType, PROMPT_ALL_DOCTORS, apiKey, 65536, DOCTORS_SCHEMA);
            setRawLogs(l => [...l, `[이미지 ${imgIdx + 1}: ${img.fileName}]\n${raw}`]);
            const parsed = safeParseJson(raw);
            if (parsed?.doctors) {
              parsed.doctors.filter(d => d.name && d.department).forEach(d => {
                allDoctors.push({
                  name: d.name.trim(),
                  department: d.department.trim(),
                  schedule: (d.schedule || []).filter(s =>
                    ["월","화","수","목","금","토","일"].includes(s.day) &&
                    ["오전","오후"].includes(s.period)
                  ).map(s => ({ day: s.day, period: s.period === "오후" ? "PM" : "AM" })),
                  room: d.room?.trim() || null,
                  notes: d.notes?.trim() || null,
                });
              });
            } else {
              setRawLogs(l => [...l, `[이미지 ${imgIdx + 1}] JSON 파싱 실패`]);
            }
          } catch (e) {
            setRawLogs(l => [...l, `[이미지 ${imgIdx + 1}] 오류: ${e.message}`]);
          }
          done++;
          setProgress(p => ({ ...p, imgCurrent: done, label: `이미지 ${done}/${images.length} 완료` }));
        }));
      }

      if (!allDoctors.length) throw new Error("의사 정보를 추출할 수 없었습니다.");
      const unique = allDoctors.filter((d, i, arr) =>
        arr.findIndex(x => x.name === d.name && x.department === d.department) === i
      );
      setDoctors(unique); setStage("results");
    } catch (err) {
      setErrorMsg(err.message || "알 수 없는 오류"); setStage("error");
    }
  };

  const filtered = doctors.filter(d => {
    const q = search.toLowerCase();
    return (!q || (d.name||"").toLowerCase().includes(q) || (d.department||"").toLowerCase().includes(q))
      && (deptFilters.length === 0 || deptFilters.includes(d.department))
      && (dayFilters.length === 0 || (d.schedule||[]).some(s => dayFilters.includes(s.day)));
  });
  const allDepts = [...new Set(doctors.map(d => d.department).filter(Boolean))].sort();

  const copyTable = () => {
    const rows = filtered.map(d => {
      const sched = (d.schedule||[]).map(s => s.day + (s.period === "PM" ? "오후" : "오전")).join(", ");
      return [d.name, d.department, sched, d.room||"", d.notes||""].join("\t");
    });
    navigator.clipboard.writeText(["의사명\t진료과\t외래일정\t진료실\t비고", ...rows].join("\n"))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const toggleDay = (day) => setDayFilters(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);

  const overallPct = (() => {
    if (progress.imgTotal === 0) return 5;
    return Math.round(Math.min(99, (progress.imgCurrent / progress.imgTotal) * 100)) || 5;
  })();

  const s = {
    wrap: { maxWidth: 960, margin: "0 auto", padding: "1.5rem", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", color: "#111" },
    dropZone: { border: `1.5px dashed ${isDragging ? "#16A2B3" : "#ddd"}`, borderRadius: 12, padding: "1.5rem", textAlign: "center", cursor: "pointer", background: isDragging ? "#D9F4F7" : "#fafafa", transition: "all 0.2s" },
    btnPrimary: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "1px solid #0D8A99", background: "#0D8A99", color: "#E8F8FB" },
    btnGhost: { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", border: "0.5px solid #ddd", background: "transparent", color: "#555" },
    btnSm: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", border: "0.5px solid #ddd", background: "transparent", color: "#444" },
    card: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, overflow: "hidden" },
    th: { padding: "9px 12px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#888", borderBottom: "0.5px solid #ddd", background: "#f9f9f9", textTransform: "uppercase", letterSpacing: "0.04em" },
    td: { padding: "10px 12px", borderBottom: "0.5px solid #f5f5f5", color: "#222", verticalAlign: "top", wordBreak: "keep-all", fontSize: 13 },
    pillAM: { display: "inline-block", margin: "2px 2px 2px 0", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#D9F4F7", color: "#076478", border: "0.5px solid #77CED9" },
    pillPM: { display: "inline-block", margin: "2px 2px 2px 0", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#FAEEDA", color: "#633806", border: "0.5px solid #FAC775" },
    deptBadge: { display: "inline-block", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#f4f4f4", border: "0.5px solid #ddd", color: "#666" },
    countBadge: { display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 500, background: "#77CED9", color: "#076478" },
    filterInput: { flex: 1, minWidth: 140, padding: "6px 10px", fontSize: 13, border: "0.5px solid #ddd", borderRadius: 8, background: "#f9f9f9", color: "#222", outline: "none" },
    errorBox: { padding: "14px 16px", background: "#FCEBEB", border: "0.5px solid #F7C1C1", borderRadius: 12, color: "#791F1F", fontSize: 13 },
    rawBox: { marginTop: 8, padding: 10, background: "#f9f9f9", borderRadius: 8, fontSize: 11, color: "#888", lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto" },
    progressCard: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, padding: "2rem", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 },
    progressBar: { width: "100%", maxWidth: 400, height: 6, background: "#eee", borderRadius: 99, overflow: "hidden" },
    apiKeyBox: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, padding: "1.5rem", marginBottom: "1.5rem" },
    apiKeyInput: { width: "100%", padding: "8px 12px", fontSize: 13, border: "0.5px solid #ddd", borderRadius: 8, outline: "none", boxSizing: "border-box", fontFamily: "monospace" },
  };

  return (
    <div style={s.wrap}>
      <div style={{ background: "linear-gradient(135deg, #2CC0D0 0%, #108A9B 100%)", borderRadius: 16, padding: "20px 22px 18px", marginBottom: "1.5rem", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", right: -50, top: -50, width: 160, height: 160, borderRadius: "50%", background: "rgba(255,255,255,0.07)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", right: 40, bottom: -30, width: 100, height: 100, borderRadius: "50%", background: "rgba(255,255,255,0.05)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", top: 14, right: 14, background: "rgba(0,0,0,0.28)", color: "#fff", fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 20, letterSpacing: "0.06em" }}>시간표</div>
        <div style={{ marginBottom: 10 }}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect x="18" y="14" width="22" height="26" rx="4" fill="rgba(255,200,230,0.28)" stroke="rgba(255,255,255,0.28)" strokeWidth="1.5"/>
            <rect x="13" y="9" width="22" height="26" rx="4" fill="rgba(200,150,230,0.42)" stroke="rgba(255,255,255,0.42)" strokeWidth="1.5"/>
            <rect x="8" y="4" width="22" height="26" rx="4" fill="rgba(230,185,250,0.62)" stroke="rgba(255,255,255,0.65)" strokeWidth="1.5"/>
            <path d="M19 13v10M14 18h10" stroke="rgba(235,70,80,0.92)" strokeWidth="3" strokeLinecap="round"/>
          </svg>
        </div>
        <div style={{ color: "#fff", fontSize: 20, fontWeight: 700, letterSpacing: "-0.3px" }}>Hospital TimeTable</div>
        <div style={{ color: "rgba(255,255,255,0.72)", fontSize: 12, marginTop: 3 }}>병원 진료 일정과 시간표를 한눈에 정리·관리할 수 있는 스케줄 뷰어입니다</div>
        <div style={{ marginTop: 10, display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(220,50,50,0.22)", border: "0.5px solid rgba(255,150,150,0.45)", color: "rgba(255,210,210,0.95)", fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 20, letterSpacing: "0.08em" }}>
          🔒 INTERNAL USE ONLY
        </div>
        {!BUNDLED_API_KEY && apiKey && (
          <button style={{ marginTop: 8, padding: "5px 10px", borderRadius: 8, fontSize: 11, cursor: "pointer", border: "0.5px solid rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.88)", display: "inline-flex", alignItems: "center", gap: 5 }}
            onClick={() => { localStorage.removeItem("gemini_api_key"); setApiKey(""); setShowApiKeySetup(true); }}>
            🔑 API키 변경
          </button>
        )}
      </div>

      {showApiKeySetup && (
        <div style={s.apiKeyBox}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>🔑 Google Gemini API 키 설정</div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>Gemini API는 <strong>무료</strong>로 사용 가능합니다.</div>
          <div style={{ fontSize: 12, color: "#0D8A99", marginBottom: 12 }}>키 발급: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{ color: "#0D8A99" }}>aistudio.google.com/apikey</a> → "Get API key"</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={s.apiKeyInput} type="password" placeholder="AIzaSy..." value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)} onKeyDown={e => e.key === "Enter" && saveApiKey()} />
            <button style={s.btnPrimary} onClick={saveApiKey}>저장</button>
          </div>
        </div>
      )}

      {!showApiKeySetup && (
        <>
          {(stage === "upload" || stage === "preview") && (
            <div>
              <div style={s.dropZone} onClick={() => fileRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={isDragging ? "#0D8A99" : "#bbb"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 8px", display: "block" }}>
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>
                </svg>
                <div style={{ fontSize: 13, color: "#666" }}><strong style={{ color: "#0D8A99" }}>클릭하거나 끌어다 놓아</strong> 사진 추가</div>
                <div style={{ fontSize: 11, color: "#bbb", marginTop: 4 }}>여러 장 동시 선택 가능 · JPG / PNG / WEBP</div>
                <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => addFiles(e.target.files)} />
              </div>

              {saves.length > 0 && stage === "upload" && (
                <div style={{ marginTop: 12, border: "0.5px solid #e0e0e0", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
                  <div style={{ padding: "10px 16px", background: "#f9f9f9", borderBottom: "0.5px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "#555" }}>💾 저장된 분석 결과</span>
                    <span style={{ fontSize: 11, color: "#bbb" }}>{saves.length} / 10</span>
                  </div>
                  {saves.map(entry => (
                    <div key={entry.id} style={{ padding: "10px 16px", borderBottom: "0.5px solid #f5f5f5", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "#222", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.hospitalName || "병원명 없음"}</div>
                        <div style={{ fontSize: 11, color: "#aaa", marginTop: 2 }}>{entry.count}명 · {new Date(entry.savedAt).toLocaleString("ko-KR")}</div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button style={s.btnGhost} onClick={() => loadFromSaved(entry)}>불러오기</button>
                        <button style={{ ...s.btnSm, color: "#ccc", fontSize: 11 }} onClick={() => deleteSaved(entry.id)}>삭제</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {images.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                    {images.map((img, idx) => (
                      <div key={img.id} style={{ position: "relative", width: 86, flexShrink: 0 }}>
                        <img src={img.src} alt={img.fileName} style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover", borderRadius: 8, border: "0.5px solid #ddd", display: "block" }} />
                        <div style={{ position: "absolute", top: 4, left: 5, fontSize: 10, fontWeight: 700, color: "#fff", background: "rgba(0,0,0,0.45)", borderRadius: 4, padding: "1px 5px" }}>{idx + 1}</div>
                        <button onClick={() => removeImage(img.id)} style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.5)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>✕</button>
                        <div style={{ fontSize: 10, color: "#aaa", textAlign: "center", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{img.fileSize}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button style={s.btnPrimary} onClick={analyze}>✦ {images.length}장 전체 분석 시작</button>
                    <button style={s.btnGhost} onClick={reset}>↺ 초기화</button>
                    <span style={{ fontSize: 12, color: "#aaa" }}>{images.length}개 이미지 준비됨</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {stage === "analyzing" && (
            <div style={s.progressCard}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", border: "2.5px solid #eee", borderTopColor: "#0D8A99", animation: "spin 0.8s linear infinite" }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{progress.label}</div>
                {images.length > 1 && progress.imgCurrent > 0 && (
                  <div style={{ fontSize: 12, color: "#bbb", marginTop: 4 }}>{progress.imgCurrent} / {progress.imgTotal} 완료</div>
                )}
              </div>
              <div style={s.progressBar}><div style={{ height: "100%", width: overallPct + "%", background: "#0D8A99", borderRadius: 99, transition: "width 0.3s ease" }} /></div>
              <div style={{ fontSize: 12, color: "#bbb" }}>전체 진행률 {overallPct}%</div>
            </div>
          )}

          {stage === "error" && (
            <div>
              <div style={s.errorBox}>
                <div style={{ display: "flex", gap: 8, marginBottom: rawLogs.length ? 12 : 0 }}>
                  <span>⚠</span><div><strong>분석 오류</strong><br />{errorMsg}</div>
                </div>
                {rawLogs.length > 0 && (<><div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>진행 로그:</div><div style={{ ...s.rawBox, background: "#fff5f5", color: "#791F1F", border: "0.5px solid #F7C1C1" }}>{rawLogs.join("\n\n---\n\n")}</div></>)}
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button style={s.btnGhost} onClick={() => setStage("preview")}>← 다시 시도</button>
                <button style={s.btnGhost} onClick={reset}>↺ 새 이미지</button>
              </div>
            </div>
          )}

          {stage === "results" && (
            <div style={s.card}>
              <div style={{ padding: "12px 16px", borderBottom: "0.5px solid #eee", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "#aaa", flexShrink: 0 }}>병원명</span>
                  {editingHospital ? (
                    <input ref={hospitalInputRef} value={hospitalName}
                      onChange={e => setHospitalName(e.target.value)}
                      onBlur={() => setEditingHospital(false)}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") setEditingHospital(false); }}
                      placeholder="병원명 입력..."
                      style={{ fontSize: 13, fontWeight: 500, border: "0.5px solid #0D8A99", borderRadius: 6, padding: "3px 8px", outline: "none", color: "#111", background: "#f5fdfe", minWidth: 160 }}
                    />
                  ) : (
                    <button onClick={() => setEditingHospital(true)}
                      style={{ fontSize: 13, fontWeight: 500, color: hospitalName ? "#111" : "#bbb", background: "transparent", border: "0.5px solid transparent", borderRadius: 6, padding: "3px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                      {hospitalName || "병원명 클릭하여 수정"}
                      <span style={{ fontSize: 11, color: "#bbb" }}>✎</span>
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500 }}>
                    추출된 외래 일정
                    <span style={s.countBadge}>{viewMode === "table" ? filtered.length : doctors.length}명</span>
                    <span style={{ fontSize: 11, color: "#aaa", fontWeight: 400 }}>{allDepts.length}개 진료과 · {images.length}장 분석</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button style={s.btnSm} onClick={saveToLocal}>{savedToast ? "✓ 저장됨" : "💾 저장"}</button>
                    <button style={s.btnSm} onClick={openReport}>📄 PDF</button>
                    <button style={s.btnSm} onClick={downloadXLS}>📥 엑셀</button>
                    <button style={s.btnSm} onClick={copyTable}>{copied ? "✓ 복사됨" : "⎘ 복사"}</button>
                    <button style={{ ...s.btnSm, color: "#888" }} onClick={reset}>↺ 새 분석</button>
                  </div>
                </div>
              </div>

              <div style={{ padding: "10px 16px", borderBottom: "0.5px solid #eee", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "flex", background: "#f4f4f4", borderRadius: 8, padding: 2, flexShrink: 0 }}>
                    {[["table", "☰ 목록"], ["day", "📅 요일별"]].map(([mode, label]) => (
                      <button key={mode} onClick={() => setViewMode(mode)} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, transition: "all 0.15s", background: viewMode === mode ? "#fff" : "transparent", color: viewMode === mode ? "#111" : "#888", boxShadow: viewMode === mode ? "0 0 0 0.5px #ddd" : "none" }}>{label}</button>
                    ))}
                  </div>
                  <input style={s.filterInput} placeholder="의사명 또는 진료과 검색..." value={search} onChange={e => setSearch(e.target.value)} />
                  <DeptDropdown allDepts={allDepts} selected={deptFilters} onChange={setDeptFilters} />
                </div>
                <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#aaa", marginRight: 2 }}>요일</span>
                  {ALL_DAYS.map(day => {
                    const active = dayFilters.includes(day);
                    return (
                      <button key={day} onClick={() => toggleDay(day)} style={{ padding: "4px 10px", borderRadius: 6, border: `0.5px solid ${active ? "#0D8A99" : "#ddd"}`, background: active ? "#D9F4F7" : "transparent", color: active ? "#076478" : "#666", fontSize: 12, cursor: "pointer", fontWeight: active ? 600 : 400, transition: "all 0.12s" }}>
                        {day}
                      </button>
                    );
                  })}
                  {dayFilters.length > 0 && (
                    <button onClick={() => setDayFilters([])} style={{ padding: "4px 8px", borderRadius: 6, border: "0.5px solid #ddd", background: "transparent", color: "#aaa", fontSize: 11, cursor: "pointer" }}>✕</button>
                  )}
                </div>
              </div>

              {viewMode === "table" && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                    <colgroup><col style={{ width: 110 }}/><col style={{ width: 110 }}/><col style={{ width: 200 }}/><col style={{ width: 70 }}/><col /></colgroup>
                    <thead><tr>{["의사명","진료과","외래 일정","진료실","비고"].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {filtered.length === 0
                        ? <tr><td colSpan={5} style={{ ...s.td, textAlign: "center", color: "#bbb", padding: "2rem" }}>검색 결과가 없습니다</td></tr>
                        : filtered.map((d, i) => {
                          const isEditing = editingDoctor?.name === d.name && editingDoctor?.department === d.department;
                          const deptC = d.department ? deptColor(d.department, allDepts) : null;
                          return (
                            <tr key={i}>
                              <td style={s.td}>
                                {isEditing ? (
                                  <input ref={doctorEditRef}
                                    value={editingDoctor.tempName}
                                    onChange={e => setEditingDoctor(prev => ({ ...prev, tempName: e.target.value }))}
                                    onBlur={commitEditDoctor}
                                    onKeyDown={e => { if (e.key === "Enter") commitEditDoctor(); if (e.key === "Escape") setEditingDoctor(null); }}
                                    style={{ fontSize: 13, fontWeight: 500, border: "0.5px solid #0D8A99", borderRadius: 6, padding: "3px 6px", outline: "none", color: "#111", background: "#f5fdfe", width: "100%", boxSizing: "border-box" }}
                                  />
                                ) : (
                                  <button onClick={() => startEditDoctor(d)}
                                    style={{ fontWeight: 500, background: "transparent", border: "0.5px solid transparent", borderRadius: 6, padding: "2px 4px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: "#111", width: "100%" }}>
                                    {d.name || "-"}<span style={{ fontSize: 10, color: "#ccc", flexShrink: 0 }}>✎</span>
                                  </button>
                                )}
                              </td>
                              <td style={s.td}>{deptC
                                ? <span style={{ display: "inline-block", padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: deptC.bg, color: deptC.text, border: `0.5px solid ${deptC.border}` }}>{d.department}</span>
                                : <span style={s.deptBadge}>-</span>
                              }</td>
                              <td style={s.td}>{!(d.schedule||[]).length
                                ? <span style={{ color: "#bbb", fontSize: 12 }}>정보 없음</span>
                                : (d.schedule||[]).map((sc, j) => <span key={j} style={sc.period === "PM" ? s.pillPM : s.pillAM}>{sc.day} {sc.period === "PM" ? "오후" : "오전"}</span>)
                              }</td>
                              <td style={{ ...s.td, fontFamily: "monospace", fontSize: 12 }}>{d.room||"-"}</td>
                              <td style={{ ...s.td, fontSize: 12, color: "#666" }}>{d.notes||"-"}</td>
                            </tr>
                          );
                        })
                      }
                    </tbody>
                  </table>
                </div>
              )}

              {viewMode === "day" && <DayView doctors={doctors} search={search} deptFilters={deptFilters} dayFilters={dayFilters} allDepts={allDepts} />}

              <div style={{ padding: "12px 16px", borderTop: "0.5px solid #eee" }}>
                <button style={{ fontSize: 12, color: "#aaa", cursor: "pointer", background: "none", border: "none", display: "flex", alignItems: "center", gap: 6, padding: 0 }} onClick={() => setShowRaw(r => !r)}>
                  {"</>"} {showRaw ? "분석 로그 숨기기" : `분석 로그 보기 (${rawLogs.length}개 항목)`}
                </button>
                {showRaw && <div style={s.rawBox}>{rawLogs.join("\n\n---\n\n")}</div>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
