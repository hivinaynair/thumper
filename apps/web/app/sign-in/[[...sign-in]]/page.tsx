import { SignIn } from "@clerk/nextjs";
import { SplineScene } from "../../components/spline-scene";

export default function SignInPage() {
  return (
    <main className="main-flush">
      <section className="hero auth-hero">
        <div className="hero-stage" aria-hidden="true">
          <SplineScene />
        </div>
        <div className="hero-scrim" aria-hidden="true" />
        <div className="hero-copy auth-copy">
          <p className="hero-kicker">Welcome back</p>
          <h1>Sign in</h1>
          <p className="hero-lede">
            Access your private Thumper booth — queue downloads and manage
            cookies.
          </p>
          <div className="auth-clerk">
            <SignIn />
          </div>
        </div>
      </section>
    </main>
  );
}
