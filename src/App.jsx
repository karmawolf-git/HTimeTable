import { useState, useRef, useCallback } from "react";

function getMediaType(file) {
  const t = file.type;
  if (["image/jpeg","image/png","image/webp","image/gif"].includes(t)) return t;
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/jpeg";
}

async function callAPI(imgBase64, imgMediaType, prompt, apiKey) {
  const res = await fetch("/api/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: imgMediaType, data: imgBase64 } },
          { type: "text", text: prompt }
        ]
      }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `API 오류 (HTTP ${res.status})`);
  return (data.content || []).map(b => b.text || "").join("").trim();
}

// Step 1: 진료과 목록만 추출
const PROMPT_DEPTS = `이 이미지는 병원 외래 스케줄 표입니다.
이미지에 있는 모든 진료과 이름을 추출해서, 줄바꿈으로 구분해서 나열하세요.
진료과 이름만 출력하고 다른 설명은 하지 마세요.

예시:
감염내과
내분비내과
류마티스내과
비뇨의학과`;

// Step 2: 특정 진료과 의사만 추출
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
      const schedule = (schedRaw||"").split(",").map(s => s.trim()).filter(Boolean).map(s => {
        const dayMatch = s.match(/^([월화수목금토일])/);
        const periodMatch = s.match(/(오전|오후)/);
        if (!dayMatch) return null;
        return { day: dayMatch[1], time: null, period: periodMatch?.[1] === "오후" ? "PM" : "AM" };
      }).filter(Boolean);
      return {
        name: name.trim(), title: null, department,
        schedule,
        room: room?.trim() === "-" ? null : room?.trim() || null,
        notes: notes?.trim() === "-" ? null : notes?.trim() || null,
      };
    }).filter(Boolean);
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("anthropic_api_key") || "");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKeySetup, setShowApiKeySetup] = useState(!localStorage.getItem("anthropic_api_key"));

  const [stage, setStage] = useState("upload");
  const [imgSrc, setImgSrc] = useState("");
  const [imgBase64, setImgBase64] = useState("");
  const [imgMediaType, setImgMediaType] = useState("image/jpeg");
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState("");
  const [progress, setProgress] = useState({ step: "", current: 0, total: 0 });
  const [doctors, setDoctors] = useState([]);
  const [rawLogs, setRawLogs] = useState([]);
  const [showRaw, setShowRaw] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [dayFilter, setDayFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileRef = useRef();

  const saveApiKey = () => {
    const key = apiKeyInput.trim();
    if (!key.startsWith("sk-ant-")) {
      alert("올바른 Anthropic API 키를 입력하세요 (sk-ant- 로 시작)");
      return;
    }
    localStorage.setItem("anthropic_api_key", key);
    setApiKey(key);
    setShowApiKeySetup(false);
    setApiKeyInput("");
  };

  const clearApiKey = () => {
    localStorage.removeItem("anthropic_api_key");
    setApiKey("");
    setShowApiKeySetup(true);
  };

  const handleFile = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const mt = getMediaType(file);
    setImgMediaType(mt); setFileName(file.name);
    setFileSize((file.size / 1024).toFixed(1) + " KB · " + mt.split("/")[1].toUpperCase());
    const reader = new FileReader();
    reader.onload = (e) => {
      setImgSrc(e.target.result);
      setImgBase64(e.target.result.split(",")[1]);
      setStage("preview");
    };
    reader.readAsDataURL(file);
  }, []);

  const reset = () => {
    setStage("upload"); setImgSrc(""); setImgBase64(""); setDoctors([]);
    setSearch(""); setDeptFilter(""); setDayFilter(""); setShowRaw(false);
    setErrorMsg(""); setRawLogs([]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const analyze = async () => {
    setStage("analyzing");
    setProgress({ step: "진료과 목록 파악 중...", current: 0, total: 0 });
    setRawLogs([]);

    try {
      // Step 1: 진료과 목록
      const deptsRaw = await callAPI(imgBase64, imgMediaType, PROMPT_DEPTS, apiKey);
      setRawLogs(l => [...l, `[진료과 목록]\n${deptsRaw}`]);

      const depts = deptsRaw.split("\n").map(l => l.trim()).filter(l => l && l.length > 1 && !l.includes("|"));
      if (!depts.length) throw new Error("진료과 목록을 찾을 수 없습니다. 스케줄 표가 잘 보이는 사진인지 확인해주세요.");

      // Step 2: 진료과별 순회
      const allDoctors = [];
      for (let i = 0; i < depts.length; i++) {
        const dept = depts[i];
        setProgress({ step: `${dept} 의사 추출 중...`, current: i + 1, total: depts.length });
        try {
          const deptRaw = await callAPI(imgBase64, imgMediaType, makeDeptPrompt(dept), apiKey);
          setRawLogs(l => [...l, `[${dept}]\n${deptRaw}`]);
          const parsed = parseDeptDoctors(deptRaw, dept);
          allDoctors.push(...parsed);
        } catch (e) {
          setRawLogs(l => [...l, `[${dept}] 오류: ${e.message}`]);
        }
        if (i < depts.length - 1) await new Promise(r => setTimeout(r, 300));
      }

      if (!allDoctors.length) throw new Error("의사 정보를 추출할 수 없었습니다.");

      const unique = allDoctors.filter((d, i, arr) =>
        arr.findIndex(x => x.name === d.name && x.department === d.department) === i
      );

      setDoctors(unique);
      setStage("results");
    } catch (err) {
      setErrorMsg(err.message || "알 수 없는 오류");
      setStage("error");
    }
  };

  const filtered = doctors.filter(d => {
    const q = search.toLowerCase();
    const mq = !q || (d.name||"").toLowerCase().includes(q) || (d.department||"").toLowerCase().includes(q);
    const md = !deptFilter || d.department === deptFilter;
    const mday = !dayFilter || (d.schedule||[]).some(s => s.day === dayFilter);
    return mq && md && mday;
  });

  const depts = [...new Set(doctors.map(d => d.department).filter(Boolean))].sort();

  const copyTable = () => {
    const rows = doctors.map(d => {
      const sched = (d.schedule||[]).map(s => s.day+(s.period==="PM"?"오후":"오전")).join(", ");
      return [d.name, d.department, sched, d.room||"", d.notes||""].join("\t");
    });
    navigator.clipboard.writeText(["의사명\t진료과\t외래일정\t진료실\t비고", ...rows].join("\n"))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const s = {
    wrap: { maxWidth: 900, margin: "0 auto", padding: "1.5rem", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
    header: { display: "flex", alignItems: "center", gap: 12, marginBottom: "1.5rem", paddingBottom: "1rem", borderBottom: "0.5px solid #ddd" },
    iconBox: { width: 36, height: 36, background: "#0F6E56", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    uploadZone: { border: `1.5px dashed ${isDragging ? "#1D9E75" : "#ccc"}`, borderRadius: 12, padding: "2.5rem 1.5rem", textAlign: "center", cursor: "pointer", background: isDragging ? "#E1F5EE" : "#fff", transition: "all 0.2s" },
    previewGrid: { display: "grid", gridTemplateColumns: "200px 1fr", gap: 16, background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, padding: "1rem" },
    previewImg: { width: "100%", aspectRatio: "3/4", objectFit: "cover", borderRadius: 8, border: "0.5px solid #ddd" },
    btnPrimary: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "1px solid #0F6E56", background: "#0F6E56", color: "#E1F5EE" },
    btnGhost: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "0.5px solid #ccc", background: "transparent", color: "#555" },
    btnSm: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", border: "0.5px solid #ccc", background: "transparent", color: "#333" },
    card: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, overflow: "hidden" },
    th: { padding: "9px 12px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#888", borderBottom: "0.5px solid #ddd", background: "#f9f9f9", textTransform: "uppercase", letterSpacing: "0.04em" },
    td: { padding: "10px 12px", borderBottom: "0.5px solid #f0f0f0", color: "#222", verticalAlign: "top", wordBreak: "keep-all", fontSize: 13 },
    pillAM: { display: "inline-block", margin: "2px 2px 2px 0", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#E1F5EE", color: "#085041", border: "0.5px solid #9FE1CB" },
    pillPM: { display: "inline-block", margin: "2px 2px 2px 0", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#FAEEDA", color: "#633806", border: "0.5px solid #FAC775" },
    deptBadge: { display: "inline-block", padding: "2px 7px", borderRadius: 4, fontSize: 11, background: "#f4f4f4", border: "0.5px solid #ddd", color: "#666" },
    badge: { display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 500, background: "#9FE1CB", color: "#085041" },
    filterInput: { flex: 1, minWidth: 140, padding: "6px 10px", fontSize: 13, border: "0.5px solid #ccc", borderRadius: 8, background: "#f9f9f9", color: "#222", outline: "none" },
    filterSelect: { padding: "6px 10px", fontSize: 13, border: "0.5px solid #ccc", borderRadius: 8, background: "#f9f9f9", color: "#222", outline: "none", cursor: "pointer" },
    errorBox: { padding: "14px 16px", background: "#FCEBEB", border: "0.5px solid #F7C1C1", borderRadius: 12, color: "#791F1F", fontSize: 13 },
    rawBox: { marginTop: 8, padding: 10, background: "#f9f9f9", borderRadius: 8, fontSize: 11, color: "#888", lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto" },
    progressCard: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, padding: "2rem", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 },
    progressBar: { width: "100%", maxWidth: 360, height: 6, background: "#eee", borderRadius: 99, overflow: "hidden" },
    progressFill: (pct) => ({ height: "100%", width: pct + "%", background: "#0F6E56", borderRadius: 99, transition: "width 0.4s ease" }),
    apiKeyBox: { background: "#fff", border: "0.5px solid #ddd", borderRadius: 12, padding: "1.5rem", marginBottom: "1.5rem" },
    apiKeyInput: { width: "100%", padding: "8px 12px", fontSize: 13, border: "0.5px solid #ccc", borderRadius: 8, outline: "none", boxSizing: "border-box", fontFamily: "monospace" },
  };

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 10;

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
          <div style={{ fontSize: 16, fontWeight: 500, color: "#111" }}>병원 스케줄 분석 에이전트</div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>외래 스케줄 사진 → 전체 의사 자동 추출 · MR 전용</div>
        </div>
        {apiKey && (
          <button style={{ ...s.btnSm, fontSize: 11, color: "#aaa" }} onClick={clearApiKey}>
            🔑 API키 변경
          </button>
        )}
      </div>

      {/* API Key 설정 */}
      {showApiKeySetup && (
        <div style={s.apiKeyBox}>
          <div style={{ fontSize: 14, fontWeight: 500, color: "#111", marginBottom: 8 }}>🔑 Anthropic API 키 설정</div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>
            Claude AI를 사용하기 위한 API 키가 필요합니다. 키는 브라우저에만 저장되며 외부로 전송되지 않습니다.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={s.apiKeyInput}
              type="password"
              placeholder="sk-ant-api..."
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveApiKey()}
            />
            <button style={s.btnPrimary} onClick={saveApiKey}>저장</button>
          </div>
        </div>
      )}

      {!showApiKeySetup && (
        <>
          {stage === "upload" && (
            <div style={s.uploadZone} onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={e => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]); }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={isDragging ? "#0F6E56" : "#aaa"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 12px", display: "block" }}>
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>
              </svg>
              <div style={{ fontSize: 14, color: "#666" }}>
                <strong style={{ color: "#0F6E56" }}>사진을 클릭하거나 끌어다 놓으세요</strong>
              </div>
              <div style={{ fontSize: 12, color: "#aaa", marginTop: 6 }}>병원 외래 스케줄 게시판 · JPG / PNG / WEBP</div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
            </div>
          )}

          {stage === "preview" && (
            <div style={s.previewGrid}>
              <img src={imgSrc} alt="스케줄" style={s.previewImg} />
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#111", wordBreak: "break-all" }}>{fileName}</div>
                  <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{fileSize}</div>
                </div>
                <p style={{ fontSize: 13, color: "#666", lineHeight: 1.6 }}>
                  진료과별로 나눠서 순차 분석하므로 모든 의사를 빠짐없이 추출합니다.<br/>
                  <span style={{ color: "#aaa", fontSize: 12 }}>⏱ 진료과 수에 따라 10~30초 소요</span>
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={s.btnPrimary} onClick={analyze}>✦ 전체 분석 시작</button>
                  <button style={s.btnGhost} onClick={reset}>↺ 다시 선택</button>
                </div>
              </div>
            </div>
          )}

          {stage === "analyzing" && (
            <div style={s.progressCard}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", border: "2.5px solid #eee", borderTopColor: "#0F6E56", animation: "spin 0.8s linear infinite" }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ fontSize: 14, fontWeight: 500, color: "#111" }}>{progress.step}</div>
              {progress.total > 0 && (
                <>
                  <div style={s.progressBar}><div style={s.progressFill(pct)} /></div>
                  <div style={{ fontSize: 12, color: "#aaa" }}>
                    {progress.current} / {progress.total} 진료과 완료 ({pct}%)
                  </div>
                </>
              )}
            </div>
          )}

          {stage === "error" && (
            <div>
              <div style={s.errorBox}>
                <div style={{ display: "flex", gap: 8, marginBottom: rawLogs.length ? 12 : 0 }}>
                  <span>⚠</span><div><strong>분석 오류</strong><br />{errorMsg}</div>
                </div>
                {rawLogs.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>진행 로그:</div>
                    <div style={{ ...s.rawBox, background: "#fff5f5", color: "#791F1F", border: "0.5px solid #F7C1C1" }}>
                      {rawLogs.join("\n\n---\n\n")}
                    </div>
                  </div>
                )}
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button style={s.btnGhost} onClick={() => setStage("preview")}>← 다시 시도</button>
                <button style={s.btnGhost} onClick={reset}>↺ 새 이미지</button>
              </div>
            </div>
          )}

          {stage === "results" && (
            <div style={s.card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "0.5px solid #ddd" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500, color: "#111" }}>
                  추출된 외래 일정
                  <span style={s.badge}>{filtered.length}명</span>
                  <span style={{ fontSize: 11, color: "#aaa", fontWeight: 400 }}>{depts.length}개 진료과</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={s.btnSm} onClick={copyTable}>{copied ? "✓ 복사됨" : "⎘ 복사"}</button>
                  <button style={{ ...s.btnSm, color: "#888" }} onClick={reset}>↺ 새 분석</button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "0.5px solid #ddd", flexWrap: "wrap" }}>
                <input style={s.filterInput} placeholder="의사명 또는 진료과 검색..." value={search} onChange={e => setSearch(e.target.value)} />
                <select style={s.filterSelect} value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
                  <option value="">전체 진료과</option>
                  {depts.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <select style={s.filterSelect} value={dayFilter} onChange={e => setDayFilter(e.target.value)}>
                  <option value="">전체 요일</option>
                  {["월","화","수","목","금","토"].map(d => <option key={d} value={d}>{d}요일</option>)}
                </select>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: 100 }}/><col style={{ width: 110 }}/><col style={{ width: 190 }}/>
                    <col style={{ width: 70 }}/><col />
                  </colgroup>
                  <thead>
                    <tr>{["의사명","진료과","외래 일정","진료실","비고"].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr><td colSpan={5} style={{ ...s.td, textAlign: "center", color: "#aaa", padding: "2rem" }}>검색 결과가 없습니다</td></tr>
                    ) : filtered.map((d, i) => (
                      <tr key={i}>
                        <td style={s.td}><span style={{ fontWeight: 500 }}>{d.name||"-"}</span></td>
                        <td style={s.td}><span style={s.deptBadge}>{d.department||"-"}</span></td>
                        <td style={s.td}>
                          {!(d.schedule||[]).length
                            ? <span style={{ color: "#aaa", fontSize: 12 }}>정보 없음</span>
                            : (d.schedule||[]).map((sc, j) => (
                              <span key={j} style={sc.period === "PM" ? s.pillPM : s.pillAM}>
                                {sc.day} {sc.period === "PM" ? "오후" : "오전"}
                              </span>
                            ))}
                        </td>
                        <td style={{ ...s.td, fontFamily: "monospace", fontSize: 12 }}>{d.room||"-"}</td>
                        <td style={{ ...s.td, fontSize: 12, color: "#666" }}>{d.notes||"-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "12px 16px", borderTop: "0.5px solid #ddd" }}>
                <button style={{ fontSize: 12, color: "#888", cursor: "pointer", background: "none", border: "none", display: "flex", alignItems: "center", gap: 6, padding: 0 }} onClick={() => setShowRaw(r => !r)}>
                  {"</>"} {showRaw ? "분석 로그 숨기기" : `분석 로그 보기 (${rawLogs.length}개 진료과)`}
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
