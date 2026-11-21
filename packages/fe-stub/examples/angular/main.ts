import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode } from '@angular/core';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

async function start() {
  if (isDevMode()) {
    const { setupStub } = await import('fe-stub');
    await setupStub(); // no-op unless `npm run start:stub` is running (or ?stub=on)
  }
  await bootstrapApplication(AppComponent, appConfig);
}

start().catch((err) => console.error(err));
