// src/environments/environment.prod.ts
// Production settings

import { initializeApp } from "firebase/app";

export const environment = {
  production: true,
  apiBaseUrl: 'https://iso20022generatorbackend-test.onrender.com',
  firebaseConfig: {
    apiKey: "AIzaSyAdEupd1RQVI8y2SNot4IB8BBubzGT5QU8",
    authDomain: "iso-validator.firebaseapp.com",
    projectId: "iso-validator",
    storageBucket: "iso-validator.firebasestorage.app",
    messagingSenderId: "246882613767",
    appId: "1:246882613767:web:9f9f4343a851eb01f888a2",
    measurementId: "G-WG5ZDJM0DT"
  }
};
const app = initializeApp(environment.firebaseConfig);
