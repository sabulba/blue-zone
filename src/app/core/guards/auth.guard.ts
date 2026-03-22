import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Auth } from '@angular/fire/auth';
import { map, take } from 'rxjs/operators';
import { user } from '@angular/fire/auth';

export const authGuard: CanActivateFn = () => {
  const auth   = inject(Auth);
  const router = inject(Router);

  return user(auth).pipe(
    take(1),
    map((u) => {
      if (u) return true;
      router.navigate(['/auth']);
      return false;
    }),
  );
};
