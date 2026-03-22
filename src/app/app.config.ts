import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideFirebaseApp, initializeApp } from '@angular/fire/app';
import { provideFirestore, getFirestore } from '@angular/fire/firestore';
import { provideAuth, getAuth } from '@angular/fire/auth';
import { routes } from './app.routes';

const firebaseConfig = {
    apiKey: "AIzaSyB0Dl7GlnjgGN6LbZ2Gy6UTSMuveRf_NaI",
    authDomain: "bluezone-3ceb0.firebaseapp.com",
    projectId: "bluezone-3ceb0",
    storageBucket: "bluezone-3ceb0.firebasestorage.app",
    messagingSenderId: "257776057750",
    appId: "1:257776057750:web:784cb47a1bbc428d8771b7",
    measurementId: "G-SJJRS2MJ56"
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideFirebaseApp(() => initializeApp(firebaseConfig)),
    provideFirestore(() => getFirestore()),
    provideAuth(() => getAuth()),
  ]
};
