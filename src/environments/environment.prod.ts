// src/environments/environment.prod.ts
// Production settings

import { initializeApp } from "firebase/app";

export const environment = {
    production: true,
     apiBaseUrl: 'https://iso20022generatorbackend-y6hp.onrender.com',
    firebaseConfig: {
       apiKey: "AIzaSyBfcr6vXTJW6Rm5mvkYz5FYPxsX0VQJxBU",
  authDomain: "isovalidator-118ef.firebaseapp.com",
  projectId: "isovalidator-118ef",
  storageBucket: "isovalidator-118ef.firebasestorage.app",
  messagingSenderId: "846063121477",
  appId: "1:846063121477:web:177dd17aa6c0aeeee95f2c",
  measurementId: "G-DLL7243BQ1"
    }
};
// const app = initializeApp(environment.firebaseConfig);