// src/environments/environment.prod.ts
// Production settings

import { initializeApp } from "firebase/app";

export const environment = {
    production: true,
     apiBaseUrl: 'https://iso20022generatorbackend.onrender.com',
    firebaseConfig: {
       apiKey: "AIzaSyCWkQ7izNkRPM4gE1HISRPnwFOgm1WrHg4",
  authDomain: "isovalidator2.firebaseapp.com",
  projectId: "isovalidator2",
  storageBucket: "isovalidator2.firebasestorage.app",
  messagingSenderId: "653661877429",
  appId: "1:653661877429:web:60861122e04af3b13c7afc",
  measurementId: "G-6HWFM21RJD"
    }
};
const app = initializeApp(environment.firebaseConfig);
