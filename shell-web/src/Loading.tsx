// The loading state, said out loud. A board that renders nothing while its
// fetch is in flight is indistinguishable from a board with nothing to say —
// and on a slow link that silence reads as broken data. Three breathing bars
// and a sentence: cheap, honest, and gone the moment the data lands.

import { C } from "./theme";

export function Loading({ label }: { label: string }) {
  return (
    <div aria-busy="true" style={{ padding: "6px 0" }}>
      <style>{`@keyframes wadl-breathe { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.9; } }`}</style>
      {[220, 460, 340].map((w, i) => (
        <div
          key={w}
          style={{
            height: 13,
            width: w,
            maxWidth: "80%",
            borderRadius: 4,
            background: "#1d1f28",
            marginBottom: 9,
            animation: `wadl-breathe 1.4s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
      <p style={{ color: C.dim, fontSize: 11.5, margin: 0 }}>{label}</p>
    </div>
  );
}
