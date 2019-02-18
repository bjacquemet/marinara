import M from '../Messages';
import { Phase } from './Timer';
import { pomodoroCount } from '../Filters';
import * as Sounds from '../Sounds';
import Notification from './Notification';
import { ExpirationPage } from './Expiration';
import Metronome from '../Metronome';
import Mutex from '../Mutex';

const token = "SLACK_TOKEN";
const slackBaseUrlProfileSet = "https://slack.com/api/users.profile.set?token=" + token + "&profile=";
const slackBaseUrlProfileGet = "https://slack.com/api/users.profile.get?token=" + token;

const Http = new XMLHttpRequest();
let formerProfile = {statusText: "", statusEmoji: ""};

class BadgeObserver
{
  onTimerStart(phase, nextPhase, elapsed, remaining) {
    let timerStart = this;
    Http.onreadystatechange = function() {
      if (this.readyState == 4 && this.status == 200) {
        let slackResponse = JSON.parse(Http.response);

        formerProfile.statusText = slackResponse.profile.status_text;
        formerProfile.statusEmoji = slackResponse.profile.status_emoji;
        timerStart.updateBadge({ phase, minutes: Math.round(remaining / 60) });
      }
    };
    Http.open("GET", slackBaseUrlProfileGet);
    Http.send();
  }

  onTimerTick(phase, nextPhase, elapsed, remaining) {
    this.updateBadge({ phase, minutes: Math.round(remaining / 60) });
  }

  onTimerStop(phase, nextPhase) {
    this.removeBadge();
    let profileJson = {
      status_emoji: formerProfile.statusEmoji,
      status_text: formerProfile.statusText
    };

    const slackProfileUpdateUrl = slackBaseUrlProfileSet + encodeURI(JSON.stringify(profileJson));
    Http.open("POST", slackProfileUpdateUrl);
    Http.send();
    Http.onreadystatechange=(e)=>{
      console.log("onTimerStop");
      console.log(Http.responseText);
    };
  }

  onTimerPause(phase, nextPhase) {
    this.updateBadge({ phase, text: '—', tooltip: M.timer_paused });
    let profileJson = {
      status_emoji: formerProfile.statusEmoji,
      status_text: formerProfile.statusText
    };

    const slackProfileUpdateUrl = slackBaseUrlProfileSet + encodeURI(JSON.stringify(profileJson));
    Http.open("POST", slackProfileUpdateUrl);
    Http.send();
    Http.onreadystatechange=(e)=>{
      console.log("onTimerPause");
      console.log(Http.responseText);
    };
  }

  onTimerResume(phase, nextPhase, elapsed, remaining) {
    this.updateBadge({ phase, minutes: Math.round(remaining / 60) });
  }

  onTimerExpire(phase, nextPhase) {
    this.removeBadge();
    let profileJson = {
      status_emoji: formerProfile.statusEmoji,
      status_text: formerProfile.statusText
    };

    const slackProfileUpdateUrl = slackBaseUrlProfileSet + encodeURI(JSON.stringify(profileJson));
    Http.open("POST", slackProfileUpdateUrl);
    Http.send();
    Http.onreadystatechange=(e)=>{
      console.log("onTimerExpire");
      console.log(Http.responseText);
    }

  }

  updateBadge({ phase, minutes, tooltip, text }) {
    let title = {
      [Phase.Focus]: M.focus_title,
      [Phase.ShortBreak]: M.short_break_title,
      [Phase.LongBreak]: M.long_break_title
    }[phase];

    let statusEmoji = phase === Phase.Focus ? ':dart:' : ':ok_hand:';
    let statusText = phase === Phase.Focus ? "I'm currently focused, I'll be back in X minutes" : "I'm in a break for still X minutes";

    if (minutes != null) {
      text = minutes < 1 ? M.less_than_minute : M.n_minutes(minutes);
      tooltip = M.browser_action_tooltip(title, M.time_remaining(text));
    } else {
      tooltip = M.browser_action_tooltip(title, tooltip);
    }
    let color = phase === Phase.Focus ? '#bb0000' : '#11aa11';

    statusText = statusText.replace("X", text.slice(0, -1));

    let profileJson = {
      status_emoji: statusEmoji,
      status_text: statusText
    };

    const slackProfileUpdateUrl = slackBaseUrlProfileSet + encodeURI(JSON.stringify(profileJson));
    Http.open("POST", slackProfileUpdateUrl);
    Http.send();
    Http.onreadystatechange=(e)=>{
      console.log(Http.responseText);
    }

    chrome.browserAction.setTitle({ title: tooltip });
    chrome.browserAction.setBadgeText({ text });
    chrome.browserAction.setBadgeBackgroundColor({ color });
  }

  removeBadge() {
    chrome.browserAction.setTitle({ title: '' });
    chrome.browserAction.setBadgeText({ text: '' });
  }
}

class TimerSoundObserver
{
  constructor(settings) {
    this.settings = settings;
    this.mutex = new Mutex();
  }

  async onTimerStart(phase) {
    if (phase !== Phase.Focus) {
      return;
    }

    let { files, bpm } = this.settings.focus.timerSound || {};
    if (files && bpm) {
      await this.mutex.exclusive(async () => {
        this.metronome && await this.metronome.close();
        this.metronome = await Metronome.create(files, (60 / bpm) * 1000);
        this.metronome.start();
      });
    }
  }

  async onTimerStop() {
    await this.mutex.exclusive(async () => {
      this.metronome && await this.metronome.close();
    });
  }

  async onTimerPause() {
    await this.mutex.exclusive(async () => {
      this.metronome && await this.metronome.stop();
    });
  }

  async onTimerResume() {
    await this.mutex.exclusive(async () => {
      this.metronome && await this.metronome.start();
    });
  }

  async onTimerExpire() {
    await this.mutex.exclusive(async () => {
      this.metronome && await this.metronome.close();
    });
  }
}

class ExpirationSoundObserver
{
  constructor(settings) {
    this.settings = settings;
  }

  onTimerExpire(phase) {
    let sound = s => s && s.notifications.sound;
    let filename = {
      [Phase.Focus]: sound(this.settings.focus),
      [Phase.ShortBreak]: sound(this.settings.shortBreak),
      [Phase.LongBreak]: sound(this.settings.longBreak)
    }[phase];

    if (filename) {
      Sounds.play(filename);
    }
  }
}

class NotificationObserver
{
  constructor(timer, settings, history) {
    this.timer = timer;
    this.settings = settings;
    this.history = history;
    this.notification = null;
    this.expiration = null;
    this.mutex = new Mutex();
  }

  onTimerStart() {
    this.mutex.exclusive(async () => {
      if (this.notification) {
        this.notification.close();
        this.notification = null;
      }

      if (this.expiration) {
        this.expiration.close();
        this.expiration = null;
      }
    });
  }

  async onTimerExpire(phase, nextPhase) {
    let settings = this.settings[{
      [Phase.Focus]: 'focus',
      [Phase.ShortBreak]: 'shortBreak',
      [Phase.LongBreak]: 'longBreak'
    }[phase]];

    let hasLongBreak = this.timer.hasLongBreak;
    let title = {
      [Phase.Focus]: M.start_focusing,
      [Phase.ShortBreak]: hasLongBreak ? M.take_a_short_break : M.take_a_break,
      [Phase.LongBreak]: M.take_a_long_break
    }[nextPhase];

    let buttonText = {
      [Phase.Focus]: M.start_focusing_now,
      [Phase.ShortBreak]: hasLongBreak ? M.start_short_break_now : M.start_break_now,
      [Phase.LongBreak]: M.start_long_break_now
    }[nextPhase];

    let action = {
      [Phase.Focus]: M.start_focusing,
      [Phase.ShortBreak]: hasLongBreak ? M.start_short_break : M.start_break,
      [Phase.LongBreak]: M.start_long_break
    }[nextPhase];

    let messages = [];
    let remaining = this.timer.pomodorosUntilLongBreak;
    if (remaining > 0) {
      messages.push(M.pomodoros_until_long_break(pomodoroCount(remaining)));
    }

    let pomodorosToday = await this.history.countToday();
    messages.push(M.pomodoros_completed_today(pomodoroCount(pomodorosToday)));

    messages = messages.filter(m => !!m);

    await this.mutex.exclusive(async () => {
      if (settings.notifications.desktop) {
        this.notification = new Notification(title, messages.join('\n'), () => this.timer.start());
        this.notification.addButton(buttonText, () => this.timer.start());
        await this.notification.show();
      }

      if (settings.notifications.tab) {
        let phaseId = {
          [Phase.Focus]: 'focus',
          [Phase.ShortBreak]: hasLongBreak ? 'short-break' : 'break',
          [Phase.LongBreak]: 'long-break'
        }[nextPhase];

        this.expiration = await ExpirationPage.show(
          title,
          messages,
          action,
          pomodorosToday,
          phaseId
        );
      }
    });
  }
}

class HistoryObserver
{
  constructor(history) {
    this.history = history;
  }

  async onTimerExpire(phase, nextPhase, duration) {
    if (phase !== Phase.Focus) {
      return;
    }

    await this.history.addPomodoro(duration);
  }
}

class MenuObserver
{
  constructor(menu) {
    this.menu = menu;
  }

  onTimerChange() {
    // Refresh menu.
    this.menu.apply();
  }
}

class TraceObserver
{
  onTimerStart(...args) {
    console.log('timer:start', ...args);
  }

  onTimerStop(...args) {
    console.log('timer:stop', ...args);
  }

  onTimerPause(...args) {
    console.log('timer:pause', ...args);
  }

  onTimerResume(...args) {
    console.log('timer:resume', ...args);
  }

  onTimerTick(...args) {
    console.log('timer:tick', ...args);
  }

  onTimerExpire(...args) {
    console.log('timer:expire', ...args);
  }

  onTimerChange(...args) {
    console.log('timer:change', ...args);
  }
}

export {
  BadgeObserver,
  TimerSoundObserver,
  ExpirationSoundObserver,
  NotificationObserver,
  HistoryObserver,
  MenuObserver,
  TraceObserver
};