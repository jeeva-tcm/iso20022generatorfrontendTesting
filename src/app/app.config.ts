import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter, withPreloading } from '@angular/router';
import { routes } from './app.routes';
import { provideAnimations } from '@angular/platform-browser/animations';
import { HttpClientModule, provideHttpClient, withFetch } from '@angular/common/http';
import { MatNativeDateModule } from '@angular/material/core';
import { SelectivePreloadStrategy } from './services/selective-preload.strategy';

export const appConfig: ApplicationConfig = {
    providers: [
        provideRouter(routes, withPreloading(SelectivePreloadStrategy)),
        provideAnimations(),
        provideHttpClient(withFetch()),
        importProvidersFrom(MatNativeDateModule)
    ]
};
