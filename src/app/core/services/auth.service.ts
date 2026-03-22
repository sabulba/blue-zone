import { Injectable, inject, signal } from '@angular/core';
import {
    Auth,
    GoogleAuthProvider,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signInWithPopup,
    signOut,
    updateProfile,
    user,
} from '@angular/fire/auth';
import { Observable, from, switchMap, of } from 'rxjs';
import { User } from '@angular/fire/auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
    private auth = inject(Auth);

    // Live stream of the current Firebase Auth user
    readonly currentUser$: Observable<User | null> = user(this.auth);

    get currentUser(): User | null {
        return this.auth.currentUser;
    }

    get uid(): string | null {
        return this.auth.currentUser?.uid ?? null;
    }

    get displayName(): string {
        const u = this.auth.currentUser;
        if (!u) return 'Player';
        // If they set a display name (Google or sign-up), use it.
        // Otherwise fall back to the part before @ in the email.
        if (u.displayName) return u.displayName;
        if (u.email)       return u.email.split('@')[0];
        return 'Player';
    }

    // ── Google sign-in ─────────────────────────────────────────────────────────
    async signInWithGoogle(): Promise<void> {
        const provider = new GoogleAuthProvider();
        await signInWithPopup(this.auth, provider);
    }

    // ── Email sign-in ──────────────────────────────────────────────────────────
    async signInWithEmail(email: string, password: string): Promise<void> {
        await signInWithEmailAndPassword(this.auth, email, password);
    }

    // ── Email sign-up ──────────────────────────────────────────────────────────
    async signUpWithEmail(email: string, password: string, displayName: string): Promise<void> {
        const cred = await createUserWithEmailAndPassword(this.auth, email, password);
        // Save the display name on the Firebase Auth profile
        await updateProfile(cred.user, { displayName });
    }

    // ── Password reset ─────────────────────────────────────────────────────────
    async sendPasswordReset(email: string): Promise<void> {
        await sendPasswordResetEmail(this.auth, email);
    }

    // ── Sign out ───────────────────────────────────────────────────────────────
    // Revokes Google OAuth token then signs out from Firebase Auth
    async signOut(): Promise<void> {
        const user = this.auth.currentUser;
        if (user) {
            // For Google provider — revoke the OAuth token so re-auth is required
            const isGoogle = user.providerData.some(p => p.providerId === 'google.com');
            if (isGoogle) {
                try {
                    // Get fresh Google credential and revoke it
                    const { GoogleAuthProvider } = await import('@angular/fire/auth');
                    const token = await user.getIdToken();
                    // Revoke via Google's endpoint
                    await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
                        method: 'POST',
                    }).catch(() => {}); // non-critical — still sign out even if revoke fails
                } catch { /* non-critical */ }
            }
        }
        await signOut(this.auth);
    }
}