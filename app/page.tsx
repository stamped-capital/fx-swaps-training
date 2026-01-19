// app/page.tsx
export default function Page() {
  // small runtime log so you can see if JS executes
  if (typeof window !== "undefined") {
    console.log("App page mounted — client JS ran");
  }

  return (
    <main style={{ minHeight: "100vh", background: "#fff", color: "#111", padding: 24 }}>
      <h1 style={{ margin: 0, fontSize: 32 }}>✅ Minimal test page</h1>
      <p style={{ marginTop: 12 }}>
        If you see this text and a white background, the app is rendering. If you still see black, check console for errors.
      </p>
      <p style={{ marginTop: 12, color: "#666" }}>
        Tip: If global CSS is setting body background to black, temporarily comment out <code>import './globals.css'</code> in app/layout.tsx.
      </p>
    </main>
  );
}
