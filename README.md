# Delivery Tracker (standalone)

An Android app for logging Uber Eats shifts. You add each delivery as you drop
it off, and the app works out your driven miles from GPS, what the shift cost
you in gas and wear, how much to set aside for taxes, and what you actually
kept. It compares every day, week and month against two monthly targets you
set: **Base** (what you need) and **Stretch** (what you'd like).

Everything runs on the phone. There is no account and no server, and it works
with no signal. Your data never leaves the phone unless you save a backup
somewhere else. The only thing the app sends out is a check of this GitHub
page for a newer version.

It needs Android 12 or newer.

## Install

1. On the phone, open the [latest release](https://github.com/Hellreaver/delivery-tracker-standalone/releases/latest)
   and tap the `.apk` file under **Assets**.
2. Chrome asks whether to allow installing apps from it. Allow it, then
   install.
3. Open **Delivery Tracker**. Allow notifications (the running shift lives in
   one) and allow location **while using the app** when you start your first
   shift.
4. Stop Android from pausing GPS mid-shift: **Settings > Apps > Delivery
   Tracker > App battery usage > Unrestricted**. Without this, a Pixel can
   stop the GPS service while the Uber app is in front and your miles come up
   short.

## Set it up for your car

Open the **Settings** tab. It starts with a 2019 Civic already filled in;
replace these numbers with your own.

### MPG

The starting value is 33, the EPA combined rating for the 2019 Civic sedan with
the 2.0L engine and CVT. Other 2019 Civics range from 29 to 36 combined
([fueleconomy.gov](https://www.fueleconomy.gov/feg/bymodel/2019_Honda_Civic.shtml)).
Your own number is better than any of them, because delivery driving is mostly
short trips:

1. Fill the tank all the way and reset a trip meter.
2. Drive normally. At the next fill-up, fill all the way again.
3. Miles on the trip meter ÷ gallons you just bought = MPG for that tank.
4. Average at least three tanks, then enter that.

### Wear $/mile (maintenance per mile)

This is everything the car costs you because you drove it: oil changes,
tires, brakes, filters, wipers, and repairs. Gas is counted separately, and
insurance and car payments are not per-mile costs, so leave them out.

The starting value is **$0.065 a mile**. CarEdge puts a Civic's maintenance
and repairs at $744 in its 7th year and $779 in its 8th
([CarEdge](https://caredge.com/honda/civic/maintenance)). A 2019 is in that
range in 2026. About $760 a year over 12,000 miles is 6.3 cents a mile,
rounded up to 6.5. That assumes an average driver's mileage, and delivery
driving adds miles fast, so work out your own when you can:

**If you have receipts** (best): add up everything from the list above for
the last year or two, then divide by the miles you drove in that time
(odometer now minus odometer then).

> wear $/mile = maintenance dollars ÷ miles driven

**If you don't**, build it from the parts that wear out, each divided by how
long it lasts:

| Item | Cost per mile |
|---|---|
| Oil change | price ÷ miles between changes |
| Tires | price for a set, installed ÷ miles the set lasts |
| Brakes | pads and rotors, installed ÷ miles they last |
| Everything else | a yearly allowance for repairs ÷ miles you drive a year |

Add the rows together. Use the prices you actually pay, and write down how you
got the number so you can update it later.

Changing wear or MPG only affects shifts saved afterwards. Old shifts keep the
numbers they were saved with.

### Gas price

Update it when the price at your usual station changes. Like MPG, each shift
keeps the price it started with.

### Taxes

Uber doesn't withhold taxes. The app sets aside a share of what you earn so
you aren't caught short:

> set-aside = tax % × (gross − IRS rate × driven miles)

The **IRS rate** is the standard mileage deduction. The app starts at $0.76 a
mile; check the current rate at [irs.gov](https://www.irs.gov/tax-professionals/standard-mileage-rates)
and enter it. The **tax set-aside %** starts at 26%. What you actually owe
depends on the rest of your income, so ask whoever does your taxes what
percentage to use. This is an estimate for budgeting, not tax advice.

### Targets

Under **Monthly targets**, enter a Base and a Stretch for each month, as
gross Uber pay (before gas and taxes):

- **Base**: the least you need from deliveries that month.
- **Stretch**: what you're aiming for.

A month with no row uses the most recent earlier one, so one row is enough
until your numbers change. The app spreads each month's target over its
days, so the Week tab shows where you should be by today.

### Good and minimum $/mile

A delivery is shown green at or above **Good $/mile** ($1.25 to start), red
below **Minimum $/mile** ($0.75), and amber in between. That's gross pay per
paid mile. Set them to the offers you'd accept and decline.

## On a shift

1. **Log** tab, pick your car, **Start shift**. GPS starts, and a notification
   shows your total, deliveries and time.
2. After each drop-off, enter the **pay**, the **paid miles**, and **Before
   tip** (what Uber paid before any tip: the fare plus promotions on the
   trip screen). Tap **Add**. The tip is whatever the pay is above "before
   tip".
3. Tips can post up to an hour later. When one does, tap that delivery and
   change the pay; the tip follows.
4. At the end, **Finish and save**. Hours and GPS miles fill themselves in.

To take a break for an errand, finish and save, then start a new shift
when you go back out. Each run is saved separately, and GPS only records while
a shift is running, so the errand's miles stay out.

To fix a shift after saving it, use **History > Edit**. The deliveries are
listed newest first, like the Uber app; the button above the list flips them
to oldest first.

## Back up your data

All your shifts live only on this phone. **Uninstalling the app deletes
them**, and so does losing the phone. Set up backups on the first day:

**Settings > Android app > Backup**:

- **Choose backup folder**: pick a folder on the phone, such as Documents.
  Every time you leave the app, it saves a copy there, at most once an hour.
  It keeps one file per day for the last 14 days, named like
  `delivery-tracker-2026-09-27.db`.
- **Save a backup now**: saves one copy wherever you choose. Pick Google Drive
  in the picker to keep a copy off the phone. Do this every week or two.
- **Restore from a backup**: replaces everything in the app with the file you
  pick. Anything you logged after that backup is gone, so it asks first. It
  won't run during a shift, and it refuses files that aren't a Delivery
  Tracker backup.

**New phone:** install the app, open it, then **Restore from a backup** and
pick your latest copy from Drive.

## Updates

**Settings > Android app** checks this page for a newer version. When there
is one, it lists what changed and offers a download button. Install the new
APK over the old app. **Don't uninstall first**; that deletes your data.
Updating keeps it.

## Problems

- **Miles look low:** check that battery usage is set to Unrestricted, and
  that location is on. The Log tab says "GPS stalled" if fixes stop arriving,
  with a button to restart it.
- **"The tracker couldn't start":** close the app fully and open it again. It
  doesn't touch your data.
- Anything else: tell whoever gave you the app, with a screenshot.
