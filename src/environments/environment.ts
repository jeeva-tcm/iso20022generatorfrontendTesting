// src/environments/environment.ts
// Local development settings
import { initializeApp } from "firebase/app";
export const environment = {
    production: false,
    apiBaseUrl: 'http://localhost:8001',
    firebaseConfig: { 
  apiKey: "AIzaSyAPTEMlCYttDUBpUm9-cz0rOQGZMJgZEuQ",
  authDomain: "isovalidatior-19may.firebaseapp.com",
  projectId: "isovalidatior-19may",
  storageBucket: "isovalidatior-19may.firebasestorage.app",
  messagingSenderId: "879073355696",
  appId: "1:879073355696:web:290f7c9e7d393b099d9875",
  measurementId: "G-J7V5H7DG1R"
    }
};
const app = initializeApp(environment.firebaseConfig);
