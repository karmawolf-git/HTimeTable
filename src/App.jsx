import { useState, useRef, useCallback } from "react";

/* ── Gemini API ───────────────────────────────────────── */
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

// 빌드 시 주입된 API 키 (없으면 빈 문자열)
const BUNDLED_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

async function callAPI(base64, mediaType, prompt, apiKey) {
  const res = await fetch(GEMINI_URL(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mediaType, data: base64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { maxOutputTokens: 1500 },
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

const PROMPT_DEPTS = `이 이미지는 병원 외래 스케줄 표입니다.
이미지에 있는 모든 진료과 이름을 추출해서, 줄바꿈으로 구분해서 나열하세요.
진료과 이름만 출력하고 다른 설명은 하지 마세요.

예시:
감염내과
내분비내과
류마티스내과
비뇨의학과`;

function makeDeptPrompt(dept) {
  return `이 이미지는 병원 외래 스케줄 표입니다.
"${dept}" 진료과에 속한 의사들만 추출해서 아래 형식으로 출력하세요.
다른 설명 없이 데이터 줄만 출력하세요.

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

/* ── 요일별 그리드 ──────────────────────────────── */
const DAYS = ["월", "화", "수", "목", "금", "토"];

function DayView({ doctors, search, deptFilter }) {
  const filtered = doctors.filter(d => {
    const q = search.toLowerCase();
    return (!q || (d.name||"").toLowerCase().includes(q) || (d.department||"").toLowerCase().includes(q))
      && (!deptFilter || d.department === deptFilter);
  });
  const matrix = {};
  DAYS.forEach(day => { matrix[`${day}_AM`] = []; matrix[`${day}_PM`] = []; });
  filtered.forEach(doc => {
    (doc.schedule || []).forEach(sc => {
      const key = `${sc.day}_${sc.period}`;
      if (matrix[key] && !matrix[key].find(x => x.name === doc.name && x.department === doc.department))
        matrix[key].push(doc);
    });
  });
  const hasAny = DAYS.some(d => matrix[`${d}_AM`].length || matrix[`${d}_PM`].length);
  if (!hasAny) return <div style={{ padding: "2rem", textAlign: "center", color: "#bbb", fontSize: 13 }}>표시할 일정이 없습니다</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
        <colgroup><col style={{ width: 52 }} />{DAYS.map(d => <col key={d} />)}</colgroup>
        <thead>
          <tr>
            <th style={{ padding: "8px 6px", background: "#f9f9f9", borderBottom: "0.5px solid #ddd", fontSize: 11, color: "#bbb" }} />
            {DAYS.map(day => (
              <th key={day} style={{ padding: "9px 8px", background: "#f9f9f9", borderBottom: "0.5px solid #ddd", borderLeft: "0.5px solid #f0f0f0", fontSize: 12, fontWeight: 600, color: "#444", textAlign: "center" }}>
                {day}요일
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {["AM", "PM"].map(period => (
            <tr key={period} style={{ verticalAlign: "top" }}>
              <td style={{ padding: "10px 4px", textAlign: "center", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", borderBottom: "0.5px solid #eee", borderRight: "0.5px solid #ddd", color: period === "AM" ? "#085041" : "#633806", background: period === "AM" ? "#f0faf5" : "#fef9f0" }}>
                {period === "AM" ? "오전" : "오후"}
              </td>
              {DAYS.map(day => {
                const list = matrix[`${day}_${period}`];
                return (
                  <td key={day} style={{ padding: "6px 8px", verticalAlign: "top", borderBottom: "0.5px solid #f0f0f0", borderLeft: "0.5px solid #f0f0f0", background: list.length ? (period === "AM" ? "#fafffe" : "#fffdf8") : "transparent", minWidth: 90 }}>
                    {list.length === 0
                      ? <span style={{ color: "#e0e0e0", fontSize: 12, display: "block", textAlign: "center", paddingTop: 6 }}>—</span>
                      : list.map((d, i) => (
                        <div key={i} style={{ marginBottom: 4, padding: "4px 6px", borderRadius: 6, background: period === "AM" ? "#E1F5EE" : "#FAEEDA", border: `0.5px solid ${period === "AM" ? "#9FE1CB" : "#FAC775"}` }}>
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
  const [apiKey, setApiKey] = useState(() =>
    BUNDLED_API_KEY || localStorage.getItem("gemini_api_key") || ""
  );
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKeySetup, setShowApiKeySetup] = useState(
    !BUNDLED_API_KEY && !localStorage.getItem("gemini_api_key")
  );

  const [images, setImages] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const idRef = useRef(0);
  const fileRef = useRef();

  const [stage, setStage] = useState("upload");
  const [progress, setProgress] = useState({ imgLabel: "", imgCurrent: 0, imgTotal: 0, deptLabel: "", deptCurrent: 0, deptTotal: 0 });
  const [doctors, setDoctors] = useState([]);
  const [rawLogs, setRawLogs] = useState([]);
  const [showRaw, setShowRaw] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const [viewMode, setViewMode] = useState("table");
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [dayFilter, setDayFilter] = useState("");
  const [copied, setCopied] = useState(false);

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
    setSearch(""); setDeptFilter(""); setDayFilter("");
    setShowRaw(false); setErrorMsg(""); setRawLogs([]);
    setViewMode("table");
    if (fileRef.current) fileRef.current.value = "";
  };

  const analyze = async () => {
    setStage("analyzing"); setRawLogs([]);
    const allDoctors = [];
    try {
      for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
        const img = images[imgIdx];
        setProgress({ imgLabel: img.fileName, imgCurrent: imgIdx + 1, imgTotal: images.length, deptLabel: "진료과 목록 파악 중...", deptCurrent: 0, deptTotal: 0 });
        const deptsRaw = await callAPI(img.base64, img.mediaType, PROMPT_DEPTS, apiKey);
        setRawLogs(l => [...l, `[이미지 ${imgIdx + 1}: ${img.fileName}]\n[진료과 목록]\n${deptsRaw}`]);
        const depts = deptsRaw.split("\n").map(l => l.trim()).filter(l => l && l.length > 1 && !l.includes("|"));
        if (!depts.length) { setRawLogs(l => [...l, `[이미지 ${imgIdx + 1}] 진료과 없음, 건너뜀`]); continue; }
        for (let di = 0; di < depts.length; di++) {
          const dept = depts[di];
          setProgress({ imgLabel: img.fileName, imgCurrent: imgIdx + 1, imgTotal: images.length, deptLabel: `${dept} 의사 추출 중...`, deptCurrent: di + 1, deptTotal: depts.length });
          try {
            const deptRaw = await callAPI(img.base64, img.mediaType, makeDeptPrompt(dept), apiKey);
            setRawLogs(l => [...l, `[이미지 ${imgIdx + 1} / ${dept}]\n${deptRaw}`]);
            allDoctors.push(...parseDeptDoctors(deptRaw, dept));
          } catch (e) {
            setRawLogs(l => [...l, `[이미지 ${imgIdx + 1} / ${dept}] 오류: ${e.message}`]);
          }
          if (di < depts.length - 1) await new Promise(r => setTimeout(r, 300));
        }
        if (imgIdx < images.length - 1) await new Promise(r => setTimeout(r, 500));
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
      && (!deptFilter || d.department === deptFilter)
      && (!dayFilter || (d.schedule||[]).some(s => s.day === dayFilter));
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

  const overallPct = progress.imgTotal > 0
    ? Math.round(((progress.imgCurrent - 1 + (progress.deptTotal > 0 ? progress.deptCurrent / progress.deptTotal : 0)) / progress.imgTotal) * 100)
    : 5;

  const s = {
    wrap: { maxWidth: 960, margin: "0 auto", padding: "1.5rem", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", color: "#111" },
    header: { display: "flex", alignItems: "center", gap: 12, marginBottom: "1.5rem", paddingBottom: "1rem", borderBottom: "0.5px solid #eee" },
    iconBox: { width: 36, height: 36, background: "#0F6E56", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    dropZone: { border: `1.5px dashed ${isDragging ? "#1D9E75" : "#ddd"}`, borderRadius: 12, padding: "1.5rem", textAlign: "center", cursor: "pointer", background: isDragging ? "#E1F5EE" : "#fafafa", transition: "all 0.2s" },
    btnPrimary: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "1px solid #0F6E56", background: "#0F6E56", color: "#E1F5EE" },
    btnGhost: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "0.5px solid #ddd", background: "transparent", color: "#555" },
    btnSm: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", border: "0.5px solid #ddd", background: "transparent", color: "#444" },
    card: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, overflow: "hidden" },
    th: { padding: "9px 12px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#888", borderBottom: "0.5px solid #ddd", background: "#f9f9f9", textTransform: "uppercase", letterSpacing: "0.04em" },
    td: { padding: "10px 12px", borderBottom: "0.5px solid #f5f5f5", color: "#222", verticalAlign: "top", wordBreak: "keep-all", fontSize: 13 },
    pillAM: { display: "inline-block", margin: "2px 2px 2px 0", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#E1F5EE", color: "#085041", border: "0.5px solid #9FE1CB" },
    pillPM: { display: "inline-block", margin: "2px 2px 2px 0", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#FAEEDA", color: "#633806", border: "0.5px solid #FAC775" },
    deptBadge: { display: "inline-block", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#f4f4f4", border: "0.5px solid #ddd", color: "#666" },
    countBadge: { display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 500, background: "#9FE1CB", color: "#085041" },
    filterInput: { flex: 1, minWidth: 140, padding: "6px 10px", fontSize: 13, border: "0.5px solid #ddd", borderRadius: 8, background: "#f9f9f9", color: "#222", outline: "none" },
    filterSelect: { padding: "6px 10px", fontSize: 13, border: "0.5px solid #ddd", borderRadius: 8, background: "#f9f9f9", color: "#222", outline: "none", cursor: "pointer" },
    errorBox: { padding: "14px 16px", background: "#FCEBEB", border: "0.5px solid #F7C1C1", borderRadius: 12, color: "#791F1F", fontSize: 13 },
    rawBox: { marginTop: 8, padding: 10, background: "#f9f9f9", borderRadius: 8, fontSize: 11, color: "#888", lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto" },
    progressCard: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, padding: "2rem", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 },
    progressBar: { width: "100%", maxWidth: 400, height: 6, background: "#eee", borderRadius: 99, overflow: "hidden" },
    apiKeyBox: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, padding: "1.5rem", marginBottom: "1.5rem" },
    apiKeyInput: { width: "100%", padding: "8px 12px", fontSize: 13, border: "0.5px solid #ddd", borderRadius: 8, outline: "none", boxSizing: "border-box", fontFamily: "monospace" },
  };

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div style={s.iconBox}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#E1F5EE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/>
            <path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/>
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>병원 스케줄 분석 에이전트</div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>외래 스케줄 사진 → 전체 의사 자동 추출 · MR 전용</div>
        </div>
        {!BUNDLED_API_KEY && apiKey && (
          <button style={{ ...s.btnSm, fontSize: 11, color: "#aaa" }}
            onClick={() => { localStorage.removeItem("gemini_api_key"); setApiKey(""); setShowApiKeySetup(true); }}>
            🔑 API키 변경
          </button>
        )}
      </div>

      {showApiKeySetup && (
        <div style={s.apiKeyBox}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>🔑 Google Gemini API 키 설정</div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>Gemini API는 <strong>무료</strong>로 사용 가능합니다.</div>
          <div style={{ fontSize: 12, color: "#0F6E56", marginBottom: 12 }}>
            키 발급: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{ color: "#0F6E56" }}>aistudio.google.com/apikey</a> → “Get API key” (Google 로그인만 필요, 신용카드 불필요)
          </div>
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
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={isDragging ? "#0F6E56" : "#bbb"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 8px", display: "block" }}>
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>
                </svg>
                <div style={{ fontSize: 13, color: "#666" }}><strong style={{ color: "#0F6E56" }}>클릭하거나 끌어다 놓아</strong> 사진 추가</div>
                <div style={{ fontSize: 11, color: "#bbb", marginTop: 4 }}>여러 장 동시 선택 가능 · JPG / PNG / WEBP</div>
                <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => addFiles(e.target.files)} />
              </div>
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
              <div style={{ width: 28, height: 28, borderRadius: "50%", border: "2.5px solid #eee", borderTopColor: "#0F6E56", animation: "spin 0.8s linear infinite" }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 12, color: "#aaa", marginBottom: 4 }}>이미지 {progress.imgCurrent} / {progress.imgTotal} <span style={{ fontSize: 11 }}>{progress.imgLabel}</span></div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{progress.deptLabel}</div>
                {progress.deptTotal > 0 && <div style={{ fontSize: 12, color: "#bbb", marginTop: 4 }}>진료과 {progress.deptCurrent} / {progress.deptTotal}</div>}
              </div>
              <div style={s.progressBar}><div style={{ height: "100%", width: overallPct + "%", background: "#0F6E56", borderRadius: 99, transition: "width 0.4s ease" }} /></div>
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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "0.5px solid #eee", flexWrap: "wrap", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500 }}>
                  추출된 외래 일정
                  <span style={s.countBadge}>{viewMode === "table" ? filtered.length : doctors.length}명</span>
                  <span style={{ fontSize: 11, color: "#aaa", fontWeight: 400 }}>{allDepts.length}개 진료과 · {images.length}장 분석</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={s.btnSm} onClick={copyTable}>{copied ? "✓ 복사됨" : "⎘ 복사"}</button>
                  <button style={{ ...s.btnSm, color: "#888" }} onClick={reset}>↺ 새 분석</button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "0.5px solid #eee", flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ display: "flex", background: "#f4f4f4", borderRadius: 8, padding: 2, flexShrink: 0 }}>
                  {[["table", "☰ 목록"], ["day", "📅 요일별"]].map(([mode, label]) => (
                    <button key={mode} onClick={() => setViewMode(mode)} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, transition: "all 0.15s", background: viewMode === mode ? "#fff" : "transparent", color: viewMode === mode ? "#111" : "#888", boxShadow: viewMode === mode ? "0 0 0 0.5px #ddd" : "none" }}>{label}</button>
                  ))}
                </div>
                <input style={s.filterInput} placeholder="의사명 또는 진료과 검색..." value={search} onChange={e => setSearch(e.target.value)} />
                <select style={s.filterSelect} value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
                  <option value="">전체 진료과</option>
                  {allDepts.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                {viewMode === "table" && (
                  <select style={s.filterSelect} value={dayFilter} onChange={e => setDayFilter(e.target.value)}>
                    <option value="">전체 요일</option>
                    {["월","화","수","목","금","토"].map(d => <option key={d} value={d}>{d}요일</option>)}
                  </select>
                )}
              </div>
              {viewMode === "table" && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                    <colgroup><col style={{ width: 100 }}/><col style={{ width: 110 }}/><col style={{ width: 200 }}/><col style={{ width: 70 }}/><col /></colgroup>
                    <thead><tr>{["의사명","진료과","외래 일정","진료실","비고"].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {filtered.length === 0
                        ? <tr><td colSpan={5} style={{ ...s.td, textAlign: "center", color: "#bbb", padding: "2rem" }}>검색 결과가 없습니다</td></tr>
                        : filtered.map((d, i) => (
                          <tr key={i}>
                            <td style={s.td}><span style={{ fontWeight: 500 }}>{d.name||"-"}</span></td>
                            <td style={s.td}><span style={s.deptBadge}>{d.department||"-"}</span></td>
                            <td style={s.td}>{!(d.schedule||[]).length ? <span style={{ color: "#bbb", fontSize: 12 }}>정보 없음</span> : (d.schedule||[]).map((sc, j) => <span key={j} style={sc.period === "PM" ? s.pillPM : s.pillAM}>{sc.day} {sc.period === "PM" ? "오후" : "오전"}</span>)}</td>
                            <td style={{ ...s.td, fontFamily: "monospace", fontSize: 12 }}>{d.room||"-"}</td>
                            <td style={{ ...s.td, fontSize: 12, color: "#666" }}>{d.notes||"-"}</td>
                          </tr>
                        ))
                      }
                    </tbody>
                  </table>
                </div>
              )}
              {viewMode === "day" && <DayView doctors={doctors} search={search} deptFilter={deptFilter} />}
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
