"use client";

// New OB·1 mark — concentric rounded square + synaptic core + axon corner dots.
export function Mark({ size = 28, glow = true }: { size?: number; glow?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      style={{ display: "block" }}
    >
      <defs>
        {glow && (
          <radialGradient id="markGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#9d83ff" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#9d83ff" stopOpacity="0" />
          </radialGradient>
        )}
        <linearGradient id="markStroke" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="#d4c8ff" />
          <stop offset="100%" stopColor="#8261ff" />
        </linearGradient>
      </defs>
      {glow && <circle cx="16" cy="16" r="15" fill="url(#markGlow)" opacity="0.5" />}
      <rect
        x="3"
        y="3"
        width="26"
        height="26"
        rx="7"
        stroke="url(#markStroke)"
        strokeWidth="1.5"
        fill="rgba(130,97,255,0.08)"
      />
      <rect
        x="8"
        y="8"
        width="16"
        height="16"
        rx="4"
        stroke="#b8a6ff"
        strokeWidth="1"
        fill="none"
        opacity="0.55"
      />
      <circle cx="16" cy="16" r="2.5" fill="#d4c8ff" />
      <circle
        cx="16"
        cy="16"
        r="5"
        stroke="#9d83ff"
        strokeWidth="0.8"
        fill="none"
        opacity="0.6"
      />
      <circle cx="3" cy="3" r="1.2" fill="#8261ff" />
      <circle cx="29" cy="3" r="1.2" fill="#8261ff" opacity="0.6" />
      <circle cx="3" cy="29" r="1.2" fill="#8261ff" opacity="0.6" />
      <circle cx="29" cy="29" r="1.2" fill="#8261ff" opacity="0.4" />
    </svg>
  );
}

export function Wordmark({ size = 14 }: { size?: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontFamily: "var(--font-sans)",
        fontSize: size,
        fontWeight: 600,
        letterSpacing: "-0.02em",
        color: "var(--fg)",
      }}
    >
      <Mark size={size * 1.85} />
      <div
        style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}
      >
        <span style={{ fontSize: size, fontWeight: 600 }}>Open Brain</span>
        <span
          style={{
            fontSize: size * 0.55,
            color: "var(--fg-4)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.14em",
            marginTop: 4,
            fontWeight: 400,
          }}
        >
          OB·1
        </span>
      </div>
    </div>
  );
}
