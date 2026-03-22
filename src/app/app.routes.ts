import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'auth',
    loadComponent: () =>
      import('./screens/auth/auth.component').then((m) => m.AuthComponent),
  },
  {
    path: 'game',
    loadComponent: () =>
      import('./screens/game/game.component').then((m) => m.GameComponent),
    canActivate: [authGuard],
  },
  { path: '', redirectTo: 'auth', pathMatch: 'full' },
  { path: '**', redirectTo: 'auth' },
];
