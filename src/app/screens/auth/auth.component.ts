import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

type AuthTab = 'signin' | 'signup';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './auth.component.html',
  styleUrl: './auth.component.scss',
})
export class AuthComponent {
  private authSvc = inject(AuthService);
  private router  = inject(Router);

  tab: AuthTab = 'signin';

  // Form fields
  email       = '';
  password    = '';
  displayName = '';

  // Reset password mode
  resetMode   = false;
  resetEmail  = '';
  resetSent   = false;

  // UI state
  loading     = false;
  toast       = '';
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  selectTab(t: AuthTab): void {
    this.tab = t;
    this.resetMode = false;
    this.clearForm();
  }

  // ── Google ─────────────────────────────────────────────────────────────────
  async signInWithGoogle(): Promise<void> {
    this.loading = true;
    try {
      await this.authSvc.signInWithGoogle();
      this.router.navigate(['/game']);
    } catch {
      this.showToast('Try again!');
    } finally {
      this.loading = false;
    }
  }

  // ── Email sign-in ──────────────────────────────────────────────────────────
  async signIn(): Promise<void> {
    if (!this.email || !this.password) return;
    this.loading = true;
    try {
      await this.authSvc.signInWithEmail(this.email, this.password);
      this.router.navigate(['/game']);
    } catch {
      this.showToast('Try again!');
    } finally {
      this.loading = false;
    }
  }

  // ── Email sign-up ──────────────────────────────────────────────────────────
  async signUp(): Promise<void> {
    if (!this.email || !this.password || !this.displayName) return;
    this.loading = true;
    try {
      await this.authSvc.signUpWithEmail(this.email, this.password, this.displayName);
      this.router.navigate(['/game']);
    } catch (err: any) {
      const msg = err?.code === 'auth/email-already-in-use'
        ? 'Email already in use. Try signing in.'
        : 'Try again!';
      this.showToast(msg);
    } finally {
      this.loading = false;
    }
  }

  // ── Password reset ─────────────────────────────────────────────────────────
  async sendReset(): Promise<void> {
    if (!this.resetEmail) return;
    this.loading = true;
    try {
      await this.authSvc.sendPasswordReset(this.resetEmail);
      this.resetSent = true;
    } catch {
      this.showToast('Try again!');
    } finally {
      this.loading = false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private showToast(msg: string): void {
    this.toast = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = ''), 3000);
  }

  private clearForm(): void {
    this.email = '';
    this.password = '';
    this.displayName = '';
    this.resetEmail = '';
    this.resetSent = false;
  }

  get canSignIn(): boolean { return !!this.email && !!this.password; }
  get canSignUp(): boolean { return !!this.email && !!this.password && !!this.displayName; }
}
