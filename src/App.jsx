import { useState, useRef, useCallback, useEffect } from "react";

/* ── Gemini API ───────────────────────────────────────── */
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
const BUNDLED_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";
const SAVES_KEY = "schedule_saves_v1";
const LEGACY_KEY = "schedule_saved_data";

async function callAPI(base64, mediaType, prompt, apiKey, maxTokens = 2000) {
  const res = await fetch(GEMINI_URL(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mediaType, data: base64 } },
        { text: prompt },
      ]}],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `API 오류 (HTTP ${res.status})`);
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
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

const PROMPT_DEPTS = `이 이미지는 병원 외래 스케줄 표입니다.
스케줄 표 전체를 꼼꼼히 살펴서 모든 진료과를 반드시 전부 빠짐없이 추출하세요.
일부만 나열하지 말고, 이미지에 보이는 모든 진료과를 나열하세요.
진료과 이름만 줄바꿈으로 구분해서 출력하고, 번호나 다른 설명은 일절 출력하지 마세요.

예시:
감염내과
내분비내과
류마티스내과
비뇨의학과
심장내과
호흡기내과
헤마토로지과
소화기내과`;

function makeDeptPrompt(dept) {
  return `이 이미지는 병원 외래 스케줄 표입니다.
"${dept}" 진료과에 속한 의사들만 추출해서 아래 형식으로 출력하세요.
다른 설명 없이 데이터 줄만 출력하세요.

⚠️ 의사 이름 정확도 최우선:
• 이름의 각 한글 글자를 이미지에서 한 글자씩 정확히 읽으세요.
• 초성·중성·종성을 각각 확인하세요.
  예) 현(ㅎ+ㅕ+ㄴ) vs 원(ㅇ+ㅝ+ㄴ) — 초성 ㅎ vs ㅇ, 모음 ㅕ vs ㅝ 구분
  예) 환 vs 관 — 초성 확인
  예) 성 vs 생 — 종성 유무 확인
• 추측하지 말고 이미지에 보이는 글자 그대로 입력하세요.
• 이름 쓰기가 애매하면 이미지를 다시 한 번 자세히 살펴보세요.

형식: 이름|일정목록|진료실|비고
일정목록: 요일+오전/오후를 쉼표로 (예: 월오전,화오후,수오전)
없는 항목은 - 로 표기

예시:
홍길동|월오전,수오전,금오전,화오후|-|당뇨병 고혈압
김영희|화오전,목오전,토오전|301|종양`;
}

function parseDeptDoctors(text, department) {
  return text.split("\n")
    .map(l => l.trim())
    .filter(l => l && l.includes("|") && !l.startsWith("#") && !l.startsWith("/"))
    .map(line => {
      const parts = line.split("|");
      if (parts.length < 2) return null;
      const [name, schedRaw, room, notes] = parts;
      if (!name?.trim()) return null;
      const schedule = (schedRaw || "").split(",")
        .map(s => s.trim()).filter(Boolean)
        .map(s => {
          const dayMatch = s.match(/^([월화수목금토일])/);
          const periodMatch = s.match(/(오전|오후)/);
          if (!dayMatch) return null;
          return { day: dayMatch[1], period: periodMatch?.[1] === "오후" ? "PM" : "AM" };
        }).filter(Boolean);
      return {
        name: name.trim(), department, schedule,
        room: room?.trim() === "-" ? null : room?.trim() || null,
        notes: notes?.trim() === "-" ? null : notes?.trim() || null,
      };
    }).filter(Boolean);
}

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

function DayView({ doctors, search, deptFilters, dayFilters }) {
  const activeDays = dayFilters.length > 0 ? ALL_DAYS.filter(d => dayFilters.includes(d)) : ALL_DAYS;
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
                      : list.map((d, i) => (
                        <div key={i} style={{ marginBottom: 4, padding: "4px 6px", borderRadius: 6, background: period === "AM" ? "#D9F4F7" : "#FAEEDA", border: `0.5px solid ${period === "AM" ? "#77CED9" : "#FAC775"}` }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#111", lineHeight: 1.3 }}>{d.name}</div>
                          <div style={{ fontSize: 10, color: "#888", marginTop: 1 }}>{d.department}{d.room ? ` · ${d.room}호` : ""}</div>
                        </div>
                      ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
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
  const [progress, setProgress] = useState({ imgCurrent: 0, imgTotal: 0, deptLabel: "", deptCurrent: 0, deptTotal: 0 });
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

  /* 저장 목록 (최대 10개) — 이전 단일 저장 포맷 자동 마이그레이션 */
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

  /* 의사 이름 인라인 편집 */
  const [editingDoctor, setEditingDoctor] = useState(null);
  const doctorEditRef = useRef();
  useEffect(() => {
    if (editingDoctor) doctorEditRef.current?.focus();
  }, [editingDoctor]);

  useEffect(() => {
    if (editingHospital) hospitalInputRef.current?.focus();
  }, [editingHospital]);

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

  const loadFromSaved = (entry) => {
    setDoctors(entry.doctors);
    setHospitalName(entry.hospitalName || "");
    setStage("results");
  };

  const deleteSaved = (id) => {
    const next = saves.filter(s => s.id !== id);
    localStorage.setItem(SAVES_KEY, JSON.stringify(next));
    setSaves(next);
  };

  const downloadCSV = () => {
    const rows = [
      ["의사명", "진료과", "외래일정", "진료실", "비고"],
      ...doctors.map(d => [
        d.name || "", d.department || "",
        (d.schedule||[]).map(s => s.day + (s.period === "PM" ? "오후" : "오전")).join(" "),
        d.room || "", d.notes || "",
      ]),
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `외래스케줄${hospitalName ? `_${hospitalName}` : ""}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const analyze = async () => {
    setStage("analyzing"); setRawLogs([]); setHospitalName("");
    const allDoctors = [];
    try {
      const firstImg = images[0];
      setProgress({ imgCurrent: 0, imgTotal: images.length, deptLabel: "병원명 파악 중...", deptCurrent: 0, deptTotal: 0 });
      try {
        const nameRaw = await callAPI(firstImg.base64, firstImg.mediaType, PROMPT_HOSPITAL, apiKey, 100);
        const extractedName = nameRaw.trim().split("\n")[0].trim();
        if (extractedName) setHospitalName(extractedName);
        setRawLogs(l => [...l, `[병원명 추출] ${extractedName || "(미확인)"}`]);
      } catch {}

      setProgress({ imgCurrent: 0, imgTotal: images.length, deptLabel: "진료과 목록 파악 중...", deptCurrent: 0, deptTotal: 0 });
      let deptsDone = 0;
      const imageDepts = await Promise.all(images.map(async (img, imgIdx) => {
        const deptsRaw = await callAPI(img.base64, img.mediaType, PROMPT_DEPTS, apiKey, 4096);
        setRawLogs(l => [...l, `[이미지 ${imgIdx + 1}: ${img.fileName}]\n[진료과 목록]\n${deptsRaw}`]);
        const depts = deptsRaw.split("\n").map(l => l.trim()).filter(l => l && l.length > 1 && !l.includes("|"));
        if (!depts.length) setRawLogs(l => [...l, `[이미지 ${imgIdx + 1}] 진료과 없음, 건너뜀`]);
        deptsDone++;
        setProgress(p => ({ ...p, imgCurrent: deptsDone }));
        return { img, imgIdx, depts };
      }));

      const tasks = [];
      imageDepts.forEach(({ img, imgIdx, depts }) => depts.forEach(dept => tasks.push({ img, imgIdx, dept })));
      if (!tasks.length) throw new Error("진료과 정보를 추출할 수 없었습니다.");

      const CONCURRENCY = 4;
      let done = 0;
      setProgress(p => ({ ...p, deptLabel: "의사 정보 추출 중...", deptCurrent: 0, deptTotal: tasks.length }));

      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.allSettled(batch.map(async ({ img, imgIdx, dept }) => {
          try {
            const deptRaw = await callAPI(img.base64, img.mediaType, makeDeptPrompt(dept), apiKey, 2000);
            setRawLogs(l => [...l, `[이미지 ${imgIdx + 1} / ${dept}]\n${deptRaw}`]);
            allDoctors.push(...parseDeptDoctors(deptRaw, dept));
          } catch (e) {
            setRawLogs(l => [...l, `[이미지 ${imgIdx + 1} / ${dept}] 오류: ${e.message}`]);
          }
          done++;
          setProgress(p => ({ ...p, deptCurrent: done, deptLabel: `${dept} 추출 완료 (${done}/${tasks.length})` }));
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
    const rows = doctors.map(d => {
      const sched = (d.schedule||[]).map(s => s.day + (s.period === "PM" ? "오후" : "오전")).join(", ");
      return [d.name, d.department, sched, d.room||"", d.notes||""].join("\t");
    });
    navigator.clipboard.writeText(["의사명\t진료과\t외래일정\t진료실\t비고", ...rows].join("\n"))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const toggleDay = (day) => setDayFilters(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);

  const overallPct = (() => {
    if (progress.imgTotal === 0) return 5;
    const phase1 = (progress.imgCurrent / progress.imgTotal) * 30;
    const phase2 = progress.deptTotal > 0 ? (progress.deptCurrent / progress.deptTotal) * 70 : 0;
    return Math.round(Math.min(99, phase1 + phase2)) || 5;
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

      {/* ── 헤더 배너 ── */}
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
        {!BUNDLED_API_KEY && apiKey && (
          <button style={{ marginTop: 12, padding: "5px 10px", borderRadius: 8, fontSize: 11, cursor: "pointer", border: "0.5px solid rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.88)", display: "inline-flex", alignItems: "center", gap: 5 }}
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

              {/* ── 저장된 병원 목록 ── */}
              {saves.length > 0 && stage === "upload" && (
                <div style={{ marginTop: 12, border: "0.5px solid #e0e0e0", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
                  <div style={{ padding: "10px 16px", background: "#f9f9f9", borderBottom: "0.5px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "#555" }}>💾 저장된 분석 결과</span>
                    <span style={{ fontSize: 11, color: "#bbb" }}>{saves.length} / 10</span>
                  </div>
                  {saves.map(entry => (
                    <div key={entry.id} style={{ padding: "10px 16px", borderBottom: "0.5px solid #f5f5f5", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "#222", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {entry.hospitalName || "병원명 없음"}
                        </div>
                        <div style={{ fontSize: 11, color: "#aaa", marginTop: 2 }}>
                          {entry.count}명 · {new Date(entry.savedAt).toLocaleString("ko-KR")}
                        </div>
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
                {images.length > 1 && <div style={{ fontSize: 12, color: "#aaa", marginBottom: 4 }}>이미지 {progress.imgCurrent} / {progress.imgTotal} 진료과 파악 완료</div>}
                <div style={{ fontSize: 14, fontWeight: 500 }}>{progress.deptLabel}</div>
                {progress.deptTotal > 0 && <div style={{ fontSize: 12, color: "#bbb", marginTop: 4 }}>{progress.deptCurrent} / {progress.deptTotal} 완료</div>}
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
                    <button style={s.btnSm} onClick={downloadCSV}>📥 CSV</button>
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
                          return (
                            <tr key={i}>
                              <td style={s.td}>
                                {isEditing ? (
                                  <input
                                    ref={doctorEditRef}
                                    value={editingDoctor.tempName}
                                    onChange={e => setEditingDoctor(prev => ({ ...prev, tempName: e.target.value }))}
                                    onBlur={commitEditDoctor}
                                    onKeyDown={e => { if (e.key === "Enter") commitEditDoctor(); if (e.key === "Escape") setEditingDoctor(null); }}
                                    style={{ fontSize: 13, fontWeight: 500, border: "0.5px solid #0D8A99", borderRadius: 6, padding: "3px 6px", outline: "none", color: "#111", background: "#f5fdfe", width: "100%", boxSizing: "border-box" }}
                                  />
                                ) : (
                                  <button onClick={() => startEditDoctor(d)}
                                    style={{ fontWeight: 500, background: "transparent", border: "0.5px solid transparent", borderRadius: 6, padding: "2px 4px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: "#111", width: "100%" }}>
                                    {d.name || "-"}
                                    <span style={{ fontSize: 10, color: "#ccc", flexShrink: 0 }}>✎</span>
                                  </button>
                                )}
                              </td>
                              <td style={s.td}><span style={s.deptBadge}>{d.department||"-"}</span></td>
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

              {viewMode === "day" && <DayView doctors={doctors} search={search} deptFilters={deptFilters} dayFilters={dayFilters} />}

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
