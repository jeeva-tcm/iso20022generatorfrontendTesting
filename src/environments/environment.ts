// src/environments/environment.ts
// Local development settings
import { initializeApp } from "firebase/app";
export const environment = {
    production: false,
    apiBaseUrl: 'http://localhost:8001',
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
