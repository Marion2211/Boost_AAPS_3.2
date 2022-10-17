/*
  Determine Basal

  Released under MIT license. See the accompanying LICENSE.txt file for
  full terms and conditions

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/


//var round_basal = require('../round-basal')

// Fix the round_basal issue?
function round_basal(basal, profile) {
    profile = 3; // force number of decimal places for the pump
    return round(basal, profile);
}

// Rounds value to 'digits' decimal places
function round(value, digits) {
    if (!digits) { digits = 0; }
    var scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
}

// we expect BG to rise or fall at the rate of BGI,
// adjusted by the rate at which BG would need to rise /
// fall to get eventualBG to target over 2 hours
function calculate_expected_delta(target_bg, eventual_bg, bgi) {
    // (hours * mins_per_hour) / 5 = how many 5 minute periods in 2h = 24
    var five_min_blocks = (2 * 60) / 5;
    var target_delta = target_bg - eventual_bg;
    return /* expectedDelta */ round(bgi + (target_delta / five_min_blocks), 1);
}


function convert_bg(value, profile) {
    if (profile.out_units === "mmol/L") {
        return round(value / 18, 1).toFixed(1);
    }
    else {
        return Math.round(value);
    }
}

function enable_smb(
    profile,
    microBolusAllowed,
    meal_data,
    target_bg
) {
    // disable SMB when a high temptarget is set
    if (!microBolusAllowed) {
        console.error("SMB disabled (!microBolusAllowed)");
        return false;
    } else if (!profile.allowSMB_with_high_temptarget && profile.temptargetSet && target_bg > profile.normal_target_bg) {
        console.error("SMB disabled due to high temptarget of", target_bg);
        return false;
    } else if (meal_data.bwFound === true && profile.A52_risk_enable === false) {
        console.error("SMB disabled due to Bolus Wizard activity in the last 6 hours.");
        return false;
    }

    // enable SMB/UAM if always-on (unless previously disabled for high temptarget)
    if (profile.enableSMB_always === true) {
        if (meal_data.bwFound) {
            console.error("Warning: SMB enabled within 6h of using Bolus Wizard: be sure to easy bolus 30s before using Bolus Wizard");
        } else {
            console.error("SMB enabled due to enableSMB_always");
        }
        return true;
    }

    // enable SMB/UAM (if enabled in preferences) while we have COB
    if (profile.enableSMB_with_COB === true && meal_data.mealCOB) {
        if (meal_data.bwCarbs) {
            console.error("Warning: SMB enabled with Bolus Wizard carbs: be sure to easy bolus 30s before using Bolus Wizard");
        } else {
            console.error("SMB enabled for COB of", meal_data.mealCOB);
        }
        return true;
    }

    // enable SMB/UAM (if enabled in preferences) for a full 6 hours after any carb entry
    // (6 hours is defined in carbWindow in lib/meal/total.js)
    if (profile.enableSMB_after_carbs === true && meal_data.carbs) {
        if (meal_data.bwCarbs) {
            console.error("Warning: SMB enabled with Bolus Wizard carbs: be sure to easy bolus 30s before using Bolus Wizard");
        } else {
            console.error("SMB enabled for 6h after carb entry");
        }
        return true;
    }

    // enable SMB/UAM (if enabled in preferences) if a low temptarget is set
    if (profile.enableSMB_with_temptarget === true && (profile.temptargetSet && target_bg < profile.normal_target_bg)) {
        if (meal_data.bwFound) {
            console.error("Warning: SMB enabled within 6h of using Bolus Wizard: be sure to easy bolus 30s before using Bolus Wizard");
        } else {
            console.error("SMB enabled for temptarget of", convert_bg(target_bg, profile));
        }
        return true;
    }

    console.error("SMB disabled (no enableSMB preferences active or no condition satisfied)");
    return false;
}

var determine_basal = function determine_basal(glucose_status, currenttemp, iob_data, profile, autosens_data, meal_data, tempBasalFunctions, microBolusAllowed, reservoir_data, currentTime, isSaveCgmSource) {
    var rT = {}; //short for requestedTemp

    var deliverAt = new Date();
    if (currentTime) {
        deliverAt = new Date(currentTime);
    }

    if (typeof profile === 'undefined' || typeof profile.current_basal === 'undefined') {
        rT.error = 'Error: could not get current basal rate';
        return rT;
    }
    var profile_current_basal = round_basal(profile.current_basal, profile);
    var basal = profile_current_basal;

    var systemTime = new Date();
    if (currentTime) {
        systemTime = currentTime;
    }
    var bgTime = new Date(glucose_status.date);
    var minAgo = round((systemTime - bgTime) / 60 / 1000, 1);

    var bg = glucose_status.glucose;
    var noise = glucose_status.noise;
    // 38 is an xDrip error state that usually indicates sensor failure
    // all other BG values between 11 and 37 mg/dL reflect non-error-code BG values, so we should zero temp for those
    if (bg <= 10 || bg === 38 || noise >= 3) {  //Dexcom is in ??? mode or calibrating, or xDrip reports high noise
        rT.reason = "CGM is calibrating, in ??? state, or noise is high";
    }
    if (minAgo > 12 || minAgo < -5) { // Dexcom data is too old, or way in the future
        rT.reason = "If current system time " + systemTime + " is correct, then BG data is too old. The last BG data was read " + minAgo + "m ago at " + bgTime;
        // if BG is too old/noisy, or is changing less than 1 mg/dL/5m for 45m, cancel any high temps and shorten any long zero temps
        //cherry pick from oref upstream dev cb8e94990301277fb1016c778b4e9efa55a6edbc
    } else if (bg > 60 && glucose_status.delta == 0 && glucose_status.short_avgdelta > -1 && glucose_status.short_avgdelta < 1 && glucose_status.long_avgdelta > -1 && glucose_status.long_avgdelta < 1 && !isSaveCgmSource) {
        if (glucose_status.last_cal && glucose_status.last_cal < 3) {
            rT.reason = "CGM was just calibrated";
        } /*else {
            rT.reason = "Error: CGM data is unchanged for the past ~45m";
        }*/
    }
    //cherry pick from oref upstream dev cb8e94990301277fb1016c778b4e9efa55a6edbc
    if (bg <= 10 || bg === 38 || noise >= 3 || minAgo > 12 || minAgo < -5) {//|| ( bg > 60 && glucose_status.delta == 0 && glucose_status.short_avgdelta > -1 && glucose_status.short_avgdelta < 1 && glucose_status.long_avgdelta > -1 && glucose_status.long_avgdelta < 1 ) && !isSaveCgmSource
        if (currenttemp.rate > basal) { // high temp is running
            rT.reason += ". Replacing high temp basal of " + currenttemp.rate + " with neutral temp of " + basal;
            rT.deliverAt = deliverAt;
            rT.temp = 'absolute';
            rT.duration = 30;
            rT.rate = basal;
            return rT;
            //return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
        } else if (currenttemp.rate === 0 && currenttemp.duration > 30) { //shorten long zero temps to 30m
            rT.reason += ". Shortening " + currenttemp.duration + "m long zero temp to 30m. ";
            rT.deliverAt = deliverAt;
            rT.temp = 'absolute';
            rT.duration = 30;
            rT.rate = 0;
            return rT;
            //return tempBasalFunctions.setTempBasal(0, 30, profile, rT, currenttemp);
        } else { //do nothing.
            rT.reason += ". Temp " + round(currenttemp.rate, 2) + " &lt;= current basal " + basal + "U/hr; doing nothing. ";
            return rT;
        }
    }

    var max_iob = profile.max_iob; // maximum amount of non-bolus IOB OpenAPS will ever deliver

    // if min and max are set, then set target to their average
    var target_bg;
    var min_bg;
    var max_bg;
    if (typeof profile.min_bg !== 'undefined') {
        min_bg = profile.min_bg;
    }
    if (typeof profile.max_bg !== 'undefined') {
        max_bg = profile.max_bg;
    }
    if (typeof profile.min_bg !== 'undefined' && typeof profile.max_bg !== 'undefined') {
        target_bg = (profile.min_bg + profile.max_bg) / 2;
    } else {
        rT.error = 'Error: could not determine target_bg. ';
        return rT;
    }
    var profileScale = (profile.use_sens_TDD && profile.sens_TDD_useProfile) ? (100.0 / profile.percent) : 1;

    var sensitivityRatio;
    var high_temptarget_raises_sensitivity = profile.exercise_mode || profile.high_temptarget_raises_sensitivity;
    var normalTarget = profile.normal_target_bg; // evaluate high/low temptarget against 100, not scheduled target (which might change)
    var halfBasalTarget = (profile.half_basal_exercise_target) ? profile.half_basal_exercise_target : 160;
    // when temptarget is 160 mg/dL, run 50% basal (120 = 75%; 140 = 60%)
    // 80 mg/dL with low_temptarget_lowers_sensitivity would give 1.5x basal, but is limited to autosens_max (1.2x by default)
    /*
    if ( high_temptarget_raises_sensitivity && profile.temptargetSet && target_bg > normalTarget
        || profile.low_temptarget_lowers_sensitivity && profile.temptargetSet && target_bg < normalTarget ) {
        // w/ target 100, temp target 110 = .89, 120 = 0.8, 140 = 0.67, 160 = .57, and 200 = .44
        // e.g.: Sensitivity ratio set to 0.8 based on temp target of 120; Adjusting basal from 1.65 to 1.35; ISF from 58.9 to 73.6
        //sensitivityRatio = 2/(2+(target_bg-normalTarget)/40);
        var c = halfBasalTarget - normalTarget;
        sensitivityRatio = c/(c+target_bg-normalTarget);
        sensitivityRatio = sensitivityRatio * autosens_data.ratio; //now apply existing sensitivity or resistance
        // limit sensitivityRatio to profile.autosens_max
        sensitivityRatio = Math.min(sensitivityRatio, profile.autosens_max);
        sensitivityRatio = round(sensitivityRatio,2);
        console.log("Sensitivity ratio set to "+sensitivityRatio+" based on temp target of "+target_bg+"; ");
    } else if (typeof autosens_data !== 'undefined' && autosens_data) {
        sensitivityRatio = autosens_data.ratio;
        console.log("Autosens ratio: "+sensitivityRatio+"; ");
    }
    */

    // Eating Now Variables, relocated for SR
    var ENactive = false, ENtimeOK = false, ENmaxIOBOK = false, enlog = "";
    //Create the time variable to be used to allow the EN to function only between certain hours
    var now = new Date(), nowdec = round(now.getHours() + now.getMinutes() / 60, 2), nowhrs = now.getHours(), nowmins = now.getMinutes();
    // calculate the epoch time for EN start and end applying an offset when end time is lower than start time
    var ENStartOffset = (profile.EatingNowTimeEnd < profile.EatingNowTimeStart && nowhrs < profile.EatingNowTimeEnd ? 86400000 : 0), ENEndOffset = (profile.EatingNowTimeEnd < profile.EatingNowTimeStart && nowhrs > profile.EatingNowTimeStart ? 86400000 : 0);
    var ENStartTime = new Date().setHours(profile.EatingNowTimeStart, 0, 0, 0) - ENStartOffset, ENEndTime = new Date().setHours(profile.EatingNowTimeEnd, 0, 0, 0) + ENEndOffset;
    // var COB = meal_data.mealCOB;
    var ENTTActive = meal_data.activeENTempTargetDuration > 0;

    // variables for deltas
    var delta = glucose_status.delta, DeltaPctS = 1, DeltaPctL = 1;
    // Calculate percentage change in delta, short to now
    if (glucose_status.short_avgdelta != 0) DeltaPctS = round(1 + ((glucose_status.delta - glucose_status.short_avgdelta) / Math.abs(glucose_status.short_avgdelta)),2);
    if (glucose_status.long_avgdelta != 0) DeltaPctL = round(1 + ((glucose_status.delta - glucose_status.long_avgdelta) / Math.abs(glucose_status.long_avgdelta)),2);

    // eating now time can be delayed if there is no first bolus or carbs
    if (now >= ENStartTime && now < ENEndTime && (meal_data.lastNormalCarbTime >= ENStartTime || meal_data.lastENBolusTime >= ENStartTime || meal_data.firstENTempTargetTime >= ENStartTime)) ENtimeOK = true;
    if (now >= ENStartTime && now < ENEndTime && profile.ENautostart) ENtimeOK = true;
    var lastNormalCarbAge = round((new Date(systemTime).getTime() - meal_data.lastNormalCarbTime) / 60000);
    // minutes since last bolus
    var lastBolusAge = ( new Date(systemTime).getTime() - meal_data.lastBolusTime ) / 60000;


    enlog += "nowhrs: " + nowhrs + ", now: " + now + "\n";
    enlog += "ENStartOffset: " + ENStartOffset + ", ENEndOffset: " + ENEndOffset + "\n";
    enlog += "ENStartTime: " + new Date(ENStartTime).toLocaleString() + "\n";
    enlog += "ENEndTime: " + new Date(ENEndTime).toLocaleString() + "\n";
    enlog += "lastNormalCarbTime: " + meal_data.lastNormalCarbTime + ", lastENBolusTime: " + meal_data.lastENBolusTime + "\n";
    enlog += "lastNormalCarbAge: " + lastNormalCarbAge + "\n";

    /*
    // set sensitivityRatio to a minimum of 1 when EN active allowing resistance, and allow <1 overnight to allow sensitivity
    sensitivityRatio = (ENtimeOK && !profile.temptargetSet ? Math.max(sensitivityRatio,1) : sensitivityRatio);
    sensitivityRatio = (profile.use_sens_TDD && !profile.temptargetSet ? 1 : sensitivityRatio);
    sensitivityRatio = (!ENtimeOK && !profile.temptargetSet ? Math.min(sensitivityRatio,1) : sensitivityRatio);


    if (sensitivityRatio) {
        basal = profile.current_basal * sensitivityRatio;
        basal = round_basal(basal, profile);
        if (basal !== profile_current_basal) {
            console.log("Adjusting basal from "+profile_current_basal+" to "+basal+"; ");
        } else {
            console.log("Basal unchanged: "+basal+"; ");
        }
    }

    // adjust min, max, and target BG for sensitivity, such that 50% increase in ISF raises target from 100 to 120
    if (profile.temptargetSet || ENtimeOK) {
        //console.log("Temp Target set, not adjusting with autosens; ");
    } else if (typeof autosens_data !== 'undefined' && autosens_data) {
        if ( profile.sensitivity_raises_target && autosens_data.ratio < 1 || profile.resistance_lowers_target && autosens_data.ratio > 1 ) {
            // with a target of 100, default 0.7-1.2 autosens min/max range would allow a 93-117 target range
            min_bg = round((min_bg - 60) / autosens_data.ratio) + 60;
            max_bg = round((max_bg - 60) / autosens_data.ratio) + 60;
            var new_target_bg = round((target_bg - 60) / autosens_data.ratio) + 60;
            // don't allow target_bg below 80
            new_target_bg = Math.max(80, new_target_bg);
            if (target_bg === new_target_bg) {
                console.log("target_bg unchanged: "+new_target_bg+"; ");
            } else {
                console.log("target_bg from "+target_bg+" to "+new_target_bg+"; ");
            }
            target_bg = new_target_bg;
        }
    }
    */

    if (typeof iob_data === 'undefined') {
        rT.error = 'Error: iob_data undefined. ';
        return rT;
    }

    var iobArray = iob_data;
    if (typeof (iob_data.length) && iob_data.length > 1) {
        iob_data = iobArray[0];
        //console.error(JSON.stringify(iob_data[0]));
    }

    if (typeof iob_data.activity === 'undefined' || typeof iob_data.iob === 'undefined') {
        rT.error = 'Error: iob_data missing some property. ';
        return rT;
    }

    // patches ==== START
    var ignoreCOB = profile.enableGhostCOB; //MD#01: Ignore any COB and rely purely on UAM after initial rise

    // Check that max iob is OK
    if (iob_data.iob <= max_iob) ENmaxIOBOK = true;

    // If we have UAM enabled with IOB less than max enable eating now mode
    if (profile.enableUAM && ENmaxIOBOK) {
        // if time is OK EN is active
        if (ENtimeOK) ENactive = true;
        // If there are COB or ENTT EN is active
        if (meal_data.mealCOB || ENTTActive) ENactive = true;
        // SAFETY: Disable EN with a TT other than normal target
        if (profile.temptargetSet && !ENTTActive) ENactive = false;
        // SAFETY: Disable EN overnight after EN hours and no override in prefs
        if (!ENtimeOK && ENactive && !profile.allowENWovernight) ENactive = false;
    }

    //ENactive = false; //DEBUG
    enlog += "ENactive: " + ENactive + ", ENtimeOK: " + ENtimeOK + "\n";
    enlog += "ENmaxIOBOK: " + ENmaxIOBOK + ", max_iob: " + max_iob + "\n";

    // patches ===== END

    var tick;

    if (glucose_status.delta > -0.5) {
        tick = "+" + round(glucose_status.delta, 0);
    } else {
        tick = round(glucose_status.delta, 0);
    }
    //var minDelta = Math.min(glucose_status.delta, glucose_status.short_avgdelta, glucose_status.long_avgdelta);
    var minDelta = Math.min(glucose_status.delta, glucose_status.short_avgdelta);
    var minAvgDelta = Math.min(glucose_status.short_avgdelta, glucose_status.long_avgdelta);
    var maxDelta = Math.max(glucose_status.delta, glucose_status.short_avgdelta, glucose_status.long_avgdelta);

    var profile_sens = round(profile.sens, 1)
    var sens = profile.sens;
    /*
    if (typeof autosens_data !== 'undefined' && autosens_data) {
        sens = profile.sens / sensitivityRatio;
        sens = round(sens, 1);
        if (sens !== profile_sens) {
            console.log("Profile ISF from "+profile_sens+" to "+sens);
        } else {
            console.log("Profile ISF unchanged: "+sens);
        }
        //console.log(" (autosens ratio "+sensitivityRatio+")");
    }
    //console.error("CR:", );
    */

    // cTime could be used for bolusing based on recent COB with Ghost COB
    var ENTime = ((new Date(systemTime).getTime() - ENStartTime) / 60000); // elapsed time since EN Start
    var c1Time = (typeof meal_data.firstCarbTime !== 'undefined' ? ((new Date(systemTime).getTime() - meal_data.firstCarbTime) / 60000) : 9999); // first carb entry after EN start
    var cTime = ((new Date(systemTime).getTime() - meal_data.lastCarbTime) / 60000); // last carb entry after EN start
    var b1Time = (typeof meal_data.firstENBolusTime !== 'undefined' ? ((new Date(systemTime).getTime() - meal_data.firstENBolusTime) / 60000) : 9999); // first normal bolus after EN start
    var bTime = (typeof meal_data.lastENBolusTime !== 'undefined' ? ((new Date(systemTime).getTime() - meal_data.lastENBolusTime) / 60000) : 9999); // last normal bolus after EN start
    var tt1Time = (typeof meal_data.firstENTempTargetTime !== 'undefined' ? ((new Date(systemTime).getTime() - meal_data.firstENTempTargetTime) / 60000) : 9999); // first EN TT after EN start
    var ttTime = (typeof meal_data.activeENTempTargetStartTime !== 'undefined' ? ((new Date(systemTime).getTime() - meal_data.activeENTempTargetStartTime) / 60000) : 9999); // active EN TT

    // ENWTriggerOK if there is enough IOB to trigger the EN window or we had a recent SMB
    //var ENWIOBThreshU = profile.current_basal * profile.ENWIOBTrigger/60, ENWTriggerOK = (ENactive && ENWIOBThreshU > 0 && iob_data.iob > ENWIOBThreshU);
    var ENWindowOK = false, ENWindowRunTime = 0, ENWIOBThreshU = profile.ENWIOBTrigger, ENWTriggerOK = (ENactive && ENWIOBThreshU > 0 && (iob_data.iob > ENWIOBThreshU));

    // breakfast/first meal related vars
    // firstMealWindow is when either c1Time or b1Time is less than EN Window
    var firstMealWindow = false;
    // if breakfast window not set use ENW
    var ENBkfstWindow = (profile.ENBkfstWindow == 0 ? profile.ENWindow : profile.ENBkfstWindow);
    if (ENactive && c1Time < profile.ENBkfstWindow) { // first cob entry is active and within EN Window
        firstMealWindow = true;
        if (b1Time != 9999 && b1Time > ENBkfstWindow) firstMealWindow = false; // first bolus has also happened and is more than EN Window
        if (tt1Time != 9999 && tt1Time > ENBkfstWindow) firstMealWindow = false; // first TT has also happened and is more than EN Window
        ENWindowRunTime = c1Time;
    } else if (ENactive && b1Time < ENBkfstWindow) { // first bolus entry is active and within EN Window
        firstMealWindow = true;
        if (c1Time != 9999 && c1Time > ENBkfstWindow) firstMealWindow = false; // first COB entry has also happened and is more than EN Window
        if (tt1Time != 9999 && tt1Time > ENBkfstWindow) firstMealWindow = false; // first TT has also happened and is more than EN Window
        ENWindowRunTime = b1Time;
    } else if (ENactive && ENTTActive && tt1Time < ENBkfstWindow) { // first bolus entry is active and within EN Window
        firstMealWindow = true;
        if (b1Time != 9999 && b1Time > ENBkfstWindow) firstMealWindow = false; // first bolus has also happened and is more than EN Window
        if (c1Time != 9999 && c1Time > ENBkfstWindow) firstMealWindow = false; // first COB entry has also happened and is more than EN Window
        ENWindowRunTime = tt1Time;
    }

    // set the ENW run and duration depending on meal type
    ENWindowRunTime = (firstMealWindow ? ENWindowRunTime : Math.min(cTime, bTime, ttTime));
    var ENWindowDuration = (firstMealWindow ? ENBkfstWindow : profile.ENWindow);
    var ENWttDuration = (meal_data.activeENTempTargetDuration > 0 ? meal_data.activeENTempTargetDuration : ENWindowDuration);
    //ENWindowDuration = (!firstMealWindow && meal_data.activeENTempTargetDuration > ENWindowDuration - ENWindowRunTime ? meal_data.activeENTempTargetDuration : ENWindowDuration);
    ENWindowDuration = (firstMealWindow ? ENWindowDuration : Math.min(ENWttDuration, ENWindowDuration));

    // ENWindowOK is when there is a recent COB entry or manual bolus
    ENWindowOK = (ENactive && ENWindowRunTime < ENWindowDuration || ENWTriggerOK);
    //if (!COB && (Math.min(b1Time,bTime) > profile.ENWindow) && !profile.temptargetSet && !ENWTriggerOK) ENWindowOK = false; // if theres no COB and no recent bolus or TT then close the EN window
    // Threshold for SMB at night

    var SMBbgOffset = (profile.SMBbgOffset > 0 ? target_bg + profile.SMBbgOffset : target_bg);
    var ENSleepMode = !ENactive && !ENtimeOK && bg < SMBbgOffset && !COB;
    enlog += "SMBbgOffset: " + SMBbgOffset + "\n";

    // Allow user preferences to adjust the scaling of ISF as BG increases
    // Scaling is converted to a percentage, 0 is normal scaling (1), 5 is 5% stronger (0.95) and -5 is 5% weaker (1.05)
    // When eating now is not active during the day or at night do not apply additional scaling unless weaker
    var ISFBGscaler = (ENSleepMode || !ENactive && ENtimeOK ? Math.min(profile.ISFbgscaler, 0) : profile.ISFbgscaler);
    enlog += "ISFBGscaler is now :" + round(ISFBGscaler, 2) + "\n";
    // Convert ISFBGscaler to %
    ISFBGscaler = (100 - ISFBGscaler) / 100;
    enlog += "ISFBGscaler % is now: " + round(ISFBGscaler, 2) + "\n";
    var ISFBGscalerVelocity = profile.ISFbgscaler_velocity / 100;
    enlog += "ISFBGscalerVelocity is now: " + ISFBGscalerVelocity + "\n";

    // stronger CR and ISF can be used when firstmeal is within 2h window
    var firstMealScaling = (firstMealWindow && !profile.use_sens_TDD && profile.sens == profile.sens_midnight && profile.carb_ratio == profile.carb_ratio_midnight);
    var carb_ratio = (firstMealScaling ? round(profile.carb_ratio_midnight / (profile.BreakfastPct / 100), 1) : profile.carb_ratio);
    sens = (firstMealScaling ? round(profile.sens_midnight / (profile.BreakfastPct / 100), 1) : sens);
    // ISF at normal target
    var sens_normalTarget = sens, sens_profile = sens;

    enlog += "ENTime: " + ENTime + "\n";
    enlog += "------ ENWindow ------" + "\n";
    enlog += "ENWindowOK:" + ENWindowOK + ", ENWindowRunTime:" + ENWindowRunTime + ", ENWindowDuration:" + ENWindowDuration + "\n";
    enlog += "ENWIOBThreshU:" + ENWIOBThreshU + ", IOB:" + iob_data.iob + "\n";
    enlog += "ENTTActive:" + ENTTActive + ", tt1Time:" + tt1Time + ", ttTime:" + ttTime + "\n";
    enlog += "b1Time:" + b1Time + ", c1Time:" + c1Time + ", bTime:" + bTime + ", cTime:" + cTime + "\n";
    enlog += "firstMealWindow:" + firstMealWindow + ", firstMealScaling:" + firstMealScaling + "\n";
    enlog += "-----------------------" + "\n";

    // UAM+ uses COB defined from prefs as prebolus within 30 minutes
    //var UAMPreBolus = (ENactive && ENTTActive && !meal_data.mealCOB && ENWindowRunTime < 30);
    var UAMCOBPreBolus = (ENactive && ENWindowRunTime < ENWindowDuration && !meal_data.mealCOB);
    if (UAMCOBPreBolus) {
        enlog += "\n* UAM COB PreBolus\n";
        // get the starting COB from prefs
        var UAM_carbs = (firstMealWindow ? profile.UAM_COB_Bkfst : profile.UAM_COB);
        enlog += "UAM_carbs from preferences: " + UAM_carbs + "\n";
        // current IOB would cover how many carbs, first 15m COB stay constant
        var COB_IOB = (ENWindowRunTime < 15 ? 0 : Math.max(iob_data.iob, 0) * carb_ratio);
        enlog += "COB_IOB to remove: " + COB_IOB + "\n";
        // remove the COB already covered by IOB restrict to 0
        var UAM_mealCOB = Math.max(UAM_carbs - COB_IOB, 0);
        enlog += "UAM_mealCOB now: " + UAM_mealCOB + "\n";
        // bring the remaining COB into the loop
        meal_data.carbs = round(UAM_carbs,1);
        meal_data.mealCOB = round(UAM_mealCOB,1);
        UAMCOBPreBolus = (meal_data.mealCOB !=0);
    }

    var COB = meal_data.mealCOB;

    // If GhostCOB is enabled we will use COB when ENWindowOK but outside this window UAM will be used
    if (ignoreCOB && ENWindowOK && COB > 0) ignoreCOB = false;

    // ins_val used as the divisor for ISF scaling
    var insulinType = profile.insulinType, ins_val = 90, ins_peak = 75;
    // insulin peak including onset min 30, max 75
    ins_peak = (profile.insulinPeak < 30 ? 30 : Math.min(profile.insulinPeak,75));
    // ins_val: Free-Peak^?:55-90, Lyumjev^45:75, Ultra-Rapid^55:65, Rapid-Acting^75:55
    ins_val = (ins_peak < 60 ? (ins_val-ins_peak)+30 : (ins_val-ins_peak)+40);
    enlog += "insulinType is " + insulinType + ", ins_val is " + ins_val + ", ins_peak is " + ins_peak+"\n";

    // TDD ********************************
    // define default vars
    var SR_TDD = 1, sens_TDD = sens, TDD = 0;
    //if (profile.use_sens_TDD || profile.enableSRTDD) {
        var tdd7 = meal_data.TDDAvg7d;
        var tdd1 = meal_data.TDDAvg1d;
        var tdd_4 = meal_data.TDDLast4h;
        var tdd_8 = meal_data.TDDLast8h;
        var tdd8to4 = meal_data.TDDLast8hfor4h;
        var tdd_last8_wt = (((1.4 * tdd_4) + (0.6 * tdd8to4)) * 3);
        var tdd8_exp = (3 * tdd_8);
        console.log("8 hour extrapolated = " + tdd8_exp + "; ");

        var TDD = (tdd_last8_wt * 0.33) + (tdd7 * 0.34) + (tdd1 * 0.33);
        console.log("TDD = " + TDD + " using rolling 8h Total extrapolation + TDD7 (60/40); ");

        // SR_TDD ********************************
        var SR_TDD = meal_data.TDDLastCannula / meal_data.TDDAvgtoCannula;

        if (profile.use_sens_TDD) {
            // ISF based on TDD
            sens_normalTarget = 1800 / ( TDD * (Math.log(( normalTarget / ins_val ) + 1 ) ) );
            enlog += "calculating sens_normalTarget: " + round(TDD, 4) + " /" + convert_bg(normalTarget, profile) + " /" + ins_val + " \n";
            enlog += "sens_normalTarget:" + convert_bg(sens_normalTarget, profile) +"\n";
            sens_normalTarget = sens_normalTarget / (profile.sens_TDD_scale / 100);
            enlog += "sens_normalTarget scaled by "+profile.sens_TDD_scale+"%:" + convert_bg(sens_normalTarget, profile) +"\n";
            sens_normalTarget = sens_normalTarget * profileScale;
            enlog += "sens_normalTarget scaled by profile "+profile.profileScale+"%:" + convert_bg(sens_normalTarget, profile) +"\n";

            sens_TDD = 1800 / ( TDD * (Math.log(( bg / ins_val ) + 1 ) ) );
            enlog += "calculating sens_TDD: " + round(TDD, 4) + " /" + convert_bg(bg, profile) + " /" + ins_val + " \n";
            enlog += "sens_TDD:" + convert_bg(sens_TDD, profile) +"\n";
            sens_TDD = sens_TDD / (profile.sens_TDD_scale / 100);
            enlog += "sens_TDD scaled by "+profile.sens_TDD_scale+"%:" + convert_bg(sens_TDD, profile) +"\n";
            sens_TDD = sens_TDD * profileScale;
            enlog += "sens_TDD scaled by profile "+profile.profileScale+"%:" + convert_bg(sens_TDD, profile) +"\n";
        }
    //}

    enlog += "* advanced ISF:\n";
    // Limit ISF increase for sens_currentBG at 10mmol / 180mgdl
    var ISFbgMax = 180;
    enlog += "ISFbgMax: " + convert_bg(ISFbgMax, profile) + "\n";

    // TIR_sens - a very simple implementation of autoISF configurable % per hour
    var TIR_sens = 0, TIRH_percent = profile.resistancePerHr/100;
    if (TIRH_percent && delta >= -4 && delta <= 4 || bg > 160) {
        enlog += "* TIR_sens:\n";
        if (meal_data.TIRW1H > 50) TIR_sens = meal_data.TIRW1H/100;
        if (meal_data.TIRW2H > 0 && TIR_sens == 1) TIR_sens += meal_data.TIRW2H/100;
        if (meal_data.TIRW3H > 0 && TIR_sens == 2) TIR_sens += meal_data.TIRW3H/100;
        if (meal_data.TIRW4H > 0 && TIR_sens == 3) TIR_sens += meal_data.TIRW4H/100;
    }
    TIR_sens = TIR_sens * TIRH_percent + 1;
    //TIR_sens = 1; // disabling as testing

    enlog += "sens_normalTarget: " + convert_bg(sens_normalTarget, profile) + "\n";
    // MaxISF is the user defined limit for sens_TDD based on a percentage of the current profile based ISF
    var MaxISF = (profile.use_sens_TDD ? sens_normalTarget : profile.sens ) / (profile.MaxISFpct / 100);
    enlog += "MaxISF: " + convert_bg(MaxISF, profile) + "\n";

    //NEW SR CODE
    // SensitivityRatio code relocated for sens_TDD
    // var SR_TDD = tdd8_exp / tdd7;
    if (high_temptarget_raises_sensitivity && profile.temptargetSet && target_bg > normalTarget || profile.low_temptarget_lowers_sensitivity && profile.temptargetSet && target_bg < normalTarget) {
        // w/ target 100, temp target 110 = .89, 120 = 0.8, 140 = 0.67, 160 = .57, and 200 = .44
        // e.g.: Sensitivity ratio set to 0.8 based on temp target of 120; Adjusting basal from 1.65 to 1.35; ISF from 58.9 to 73.6
        //sensitivityRatio = 2/(2+(target_bg-normalTarget)/40);
        var c = halfBasalTarget - normalTarget;
        sensitivityRatio = c / (c + target_bg - normalTarget);
        // limit sensitivityRatio to profile.autosens_max (1.2x by default)
        sensitivityRatio = Math.min(sensitivityRatio, profile.autosens_max);
        sensitivityRatio = round(sensitivityRatio, 2);
        enlog += "Sensitivity ratio set to " + sensitivityRatio + " based on temp target of " + target_bg + "; ";
        sens_normalTarget = sens_normalTarget / sensitivityRatio; // CHECK THIS  LINE
        //sens =  sens / sensitivityRatio ; // CHECK THIS  LINE
        sens_normalTarget = round(sens_normalTarget, 1);

        if (profile.use_sens_TDD) {
            sens_TDD = sens_TDD / sensitivityRatio;
            sens_TDD = round(sens_TDD, 1);
        }
        enlog += "sens_normalTarget now " + sens_normalTarget + "due to temp target; ";
    } else {
        sensitivityRatio = 1;
        sensitivityRatio = (typeof autosens_data !== 'undefined' && autosens_data ? autosens_data.ratio : sensitivityRatio);
    }

    // adjust profile basal and ISF based on prefs and sensitivityRatio
    if (profile.use_sens_TDD) {
        // dont adjust sens_normalTarget
        sens_normalTarget = sens_normalTarget;
        sensitivityRatio = 1;
    } else if (profile.enableSRTDD && SR_TDD !=1) {
        // dont apply autosens limits to show SR_TDD full potential
        //SR_TDD = Math.min(SR_TDD, profile.autosens_max);
        //SR_TDD = Math.max(SR_TDD, profile.autosens_min);
        sensitivityRatio = (profile.temptargetSet && !ENTTActive || profile.percent != 100 ?  1 : SR_TDD);
        // adjust basal later
        // basal = profile.current_basal * sensitivityRatio;
        // adjust sens_normalTarget below with TIR_sens
        // sens_normalTarget = sens_normalTarget / sensitivityRatio;
    } else {
        // apply autosens limits
        sensitivityRatio = Math.min(sensitivityRatio, profile.autosens_max);
        sensitivityRatio = Math.max(sensitivityRatio, profile.autosens_min);
        // adjust sens_normalTarget below with TIR_sens
        // sens_normalTarget = sens_normalTarget / sensitivityRatio;
        // adjust basal later
        //basal = profile.current_basal * sensitivityRatio;
    }

    // apply TIRS to ISF, TIRS will be 1 if not enabled, limit to autosens_max
    //TIR_sens = Math.min(TIR_sens, profile.autosens_max);
    sensitivityRatio = sensitivityRatio * TIR_sens;

    // apply final autosens limits
    sensitivityRatio = Math.min(sensitivityRatio, profile.autosens_max);
    sensitivityRatio = Math.max(sensitivityRatio, profile.autosens_min);
    sensitivityRatio = round(sensitivityRatio, 2);

    // adjust ISF
    sens_normalTarget = sens_normalTarget / sensitivityRatio;

    // adjust basal
    basal = profile.current_basal * sensitivityRatio;

    basal = round_basal(basal, profile);
    if (basal !== profile_current_basal) {
        enlog += "Adjusting basal from " + profile_current_basal + " to " + basal + "; ";
    } else {
        enlog += "Basal unchanged: " + basal + "; ";
    }

    // adjust min, max, and target BG for sensitivity, such that 50% increase in ISF raises target from 100 to 120
    if (profile.temptargetSet) {
        //console.log("Temp Target set, not adjusting with autosens; ");
    } else {
        if (profile.sensitivity_raises_target && sensitivityRatio < 1 || profile.resistance_lowers_target && sensitivityRatio > 1) {
            // with a target of 100, default 0.7-1.2 autosens min/max range would allow a 93-117 target range
            min_bg = round((min_bg - 60) / sensitivityRatio) + 60;
            max_bg = round((max_bg - 60) / sensitivityRatio) + 60;
            var new_target_bg = round((target_bg - 60) / sensitivityRatio) + 60;
            // don't allow target_bg below 80
            new_target_bg = Math.max(80, new_target_bg);
            if (target_bg === new_target_bg) {
                console.log("target_bg unchanged: " + new_target_bg + "; ");
            } else {
                console.log("target_bg from " + target_bg + " to " + new_target_bg + "; ");
            }
            target_bg = new_target_bg;
        }
    }
    //NEW SR CODE

    //circadian sensitivity curve
    // https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3879757/
    //                       Time 00 ,  01 ,  02 ,  03 ,  04 ,  05 ,  06 ,  07 ,  08 ,  09 ,  10 ,  11 ,  12 ,  13 ,  14 ,  15 ,  16 ,  17 ,  18 ,  19 ,  20 ,  21 ,  22 , 23 ,  24 .
    //var sens_circadian_curve = [1.40, 1.40, 0.80, 0.60, 0.52, 0.47, 0.43, 0.41, 0.40, 0.45, 0.60, 0.72, 0.83, 0.91, 0.97, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.20, 1.40];
    //enlog += "sens_circadian_curve["+nowhrs+"]:" + sens_circadian_curve[nowhrs]+"\n";
    enlog += "nowmins: " + nowmins + "\n";
    //var sens_circadian_now = round(sens_circadian_curve[nowhrs]+((sens_circadian_curve[nowhrs+1]-sens_circadian_curve[nowhrs])/60) * nowmins,1);

    // experimenting with basal rate from 3PM
    var sens_circadian_now = (profile.enableBasalAt3PM ? round(profile.current_basal / profile.BasalAt3PM, 2) : 1);
    enlog += "sens_circadian_now: " + sens_circadian_now + "\n";

    // Apply circadian variance to ISF
    sens_normalTarget *= sens_circadian_now;
    enlog += "sens_normalTarget with circadian variance: " + convert_bg(sens_normalTarget, profile) + "\n";

    var log_scaler = true;

    var getISFforBG = function (bg) {
        var result = 0;
        if (profile.useDynISF) {
            var sens_BG = Math.log((Math.min(bg, ISFbgMax) / ins_val) + 1);
            var scaler = sens_BG / Math.log((normalTarget / ins_val) + 1);
            var base_isf = (profile.use_sens_TDD ? sens_TDD : sens_normalTarget) * profileScale;
            var diff = base_isf - (base_isf / scaler);
            if (log_scaler) {
                enlog += "base_isf: " + round(base_isf, 2) +"\n";
                enlog += "diff: " + round(diff, 2) +"\n";
                enlog += "sens_BG: " + round(sens_BG, 2) +"\n";
                enlog += "sens_BGscaler adjusted: " + round(scaler, 2) +"\n";
                if (profileScale != 1) enlog += "scaling ISF by profile %: " + round(profileScale, 4) +"\n";
            }
            result = base_isf - diff * ISFBGscalerVelocity;
            if (!result) {
                enlog += "failed ISF for bg: " + round(bg, 2) +"\n";
                enlog += "sens_BG: " + round(sens_BG, 2) +"\n";
                enlog += "scaler: " + round(scaler, 2) +"\n";
                enlog += "profileScale: " + round(profileScale, 2) +"\n";
                enlog += "base_isf: " + round(base_isf, 2) +"\n";
                enlog += "diff: " + round(diff, 2) +"\n";
            }
        }
        else {
            result = sens_normalTarget;
        }
        return Math.max(MaxISF, result * ISFBGscaler);
    }

    // define the sensitivity for the current bg using previously defined sens at normal target
    var sens_currentBG = Math.max(MaxISF, getISFforBG(bg));
    enlog += "sens_currentBG: " + convert_bg(sens_currentBG, profile) + "\n";
    log_scaler = false;

    // SAFETY: if below normal target at night use normal ISF otherwise use dynamic ISF
    sens_currentBG = (bg < normalTarget && ENSleepMode ? sens_normalTarget : sens_currentBG);

    sens_currentBG = round(sens_currentBG, 1);
    enlog += "sens_currentBG final result: " + convert_bg(sens_currentBG, profile) + "\n";

    // sens is the current bg when EN active e.g. no TT otherwise use previously defined sens at normal target
    sens = (ENactive ? sens_currentBG : sens_normalTarget);
    // at night use sens_currentBG, additional scaling from ISFBGscaler has been reduced earlier
    sens = (!ENactive && !ENtimeOK ? sens_currentBG : sens);
    enlog += "sens final result: " + round(sens, 2) + "=" + convert_bg(sens, profile) + "\n";

    // compare currenttemp to iob_data.lastTemp and cancel temp if they don't match
    var lastTempAge;
    if (typeof iob_data.lastTemp !== 'undefined') {
        lastTempAge = round((new Date(systemTime).getTime() - iob_data.lastTemp.date) / 60000); // in minutes
    } else {
        lastTempAge = 0;
    }
    //console.error("currenttemp:",currenttemp,"lastTemp:",JSON.stringify(iob_data.lastTemp),"lastTempAge:",lastTempAge,"m");
    var tempModulus = (lastTempAge + currenttemp.duration) % 30;
    console.error("currenttemp: ", currenttemp, "lastTempAge: ", lastTempAge, "m", "tempModulus: ", tempModulus, "m");
    rT.temp = 'absolute';
    rT.deliverAt = deliverAt;
    if (microBolusAllowed && currenttemp && iob_data.lastTemp && currenttemp.rate !== iob_data.lastTemp.rate && lastTempAge > 10 && currenttemp.duration) {
        rT.reason = "Warning: currenttemp rate " + currenttemp.rate + " != lastTemp rate " + iob_data.lastTemp.rate + " from pumphistory; canceling temp";
        return tempBasalFunctions.setTempBasal(0, 0, profile, rT, currenttemp);
    }
    if (currenttemp && iob_data.lastTemp && currenttemp.duration > 0) {
        // TODO: fix this (lastTemp.duration is how long it has run; currenttemp.duration is time left
        //if ( currenttemp.duration < iob_data.lastTemp.duration - 2) {
            //rT.reason = "Warning: currenttemp duration "+currenttemp.duration+" << lastTemp duration "+round(iob_data.lastTemp.duration,1)+" from pumphistory; setting neutral temp of "+basal+".";
            //return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
        //}
        //console.error(lastTempAge, round(iob_data.lastTemp.duration,1), round(lastTempAge - iob_data.lastTemp.duration,1));
        var lastTempEnded = lastTempAge - iob_data.lastTemp.duration
        if (lastTempEnded > 5 && lastTempAge > 10) {
            rT.reason = "Warning: currenttemp running but lastTemp from pumphistory ended " + lastTempEnded + "m ago; canceling temp";
            //console.error(currenttemp, round(iob_data.lastTemp,1), round(lastTempAge,1));
            return tempBasalFunctions.setTempBasal(0, 0, profile, rT, currenttemp);
        }
        // TODO: figure out a way to do this check that doesn't fail across basal schedule boundaries
        //if ( tempModulus < 25 && tempModulus > 5 ) {
            //rT.reason = "Warning: currenttemp duration "+currenttemp.duration+" + lastTempAge "+lastTempAge+" isn't a multiple of 30m; setting neutral temp of "+basal+".";
            //console.error(rT.reason);
            //return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
        //}
    }

    //calculate BG impact: the amount BG "should" be rising or falling based on insulin activity alone
    var bgi = round((-iob_data.activity * sens * 5), 2);
    // project deviations for 30 minutes
    var deviation = round(30 / 5 * (minDelta - bgi));
    // don't overreact to a big negative delta: use minAvgDelta if deviation is negative
    if (deviation < 0) {
        deviation = round((30 / 5) * (minAvgDelta - bgi));
        // and if deviation is still negative, use long_avgdelta
        if (deviation < 0) {
            deviation = round((30 / 5) * (glucose_status.long_avgdelta - bgi));
        }
    }

    // calculate the naive (bolus calculator math) eventual BG based on net IOB and sensitivity
    if (iob_data.iob > 0) {
        var naive_eventualBG = round(bg - (iob_data.iob * sens));
    } else { // if IOB is negative, be more conservative and use the lower of sens, profile.sens
        naive_eventualBG = round(bg - (iob_data.iob * Math.min(sens, sens_normalTarget)));
    }
    // and adjust it for the deviation above
    var eventualBG = naive_eventualBG + deviation;

    // raise target for noisy / raw CGM data
    if (glucose_status.noise >= 2) {
        // increase target at least 10% (default 30%) for raw / noisy data
        var noisyCGMTargetMultiplier = Math.max(1.1, profile.noisyCGMTargetMultiplier);
        // don't allow maxRaw above 250
        var maxRaw = Math.min(250, profile.maxRaw);
        var adjustedMinBG = round(Math.min(200, min_bg * noisyCGMTargetMultiplier));
        var adjustedTargetBG = round(Math.min(200, target_bg * noisyCGMTargetMultiplier));
        var adjustedMaxBG = round(Math.min(200, max_bg * noisyCGMTargetMultiplier));
        console.log("Raising target_bg for noisy / raw CGM data, from " + target_bg + " to " + adjustedTargetBG + "; ");
        min_bg = adjustedMinBG;
        target_bg = adjustedTargetBG;
        max_bg = adjustedMaxBG;
        // adjust target BG range if configured to bring down high BG faster
    } else if (bg > max_bg && profile.adv_target_adjustments && !profile.temptargetSet) {
        // with target=100, as BG rises from 100 to 160, adjustedTarget drops from 100 to 80
        adjustedMinBG = round(Math.max(80, min_bg - (bg - min_bg) / 3), 0);
        adjustedTargetBG = round(Math.max(80, target_bg - (bg - target_bg) / 3), 0);
        adjustedMaxBG = round(Math.max(80, max_bg - (bg - max_bg) / 3), 0);
        // if eventualBG, naive_eventualBG, and target_bg aren't all above adjustedMinBG, don’t use it
        //console.error("naive_eventualBG:",naive_eventualBG+", eventualBG:",eventualBG);
        if (eventualBG > adjustedMinBG && naive_eventualBG > adjustedMinBG && min_bg > adjustedMinBG) {
            console.log("Adjusting targets for high BG: min_bg from " + min_bg + " to " + adjustedMinBG + "; ");
            min_bg = adjustedMinBG;
        } else {
            console.log("min_bg unchanged: " + min_bg + "; ");
        }
        // if eventualBG, naive_eventualBG, and target_bg aren't all above adjustedTargetBG, don’t use it
        if (eventualBG > adjustedTargetBG && naive_eventualBG > adjustedTargetBG && target_bg > adjustedTargetBG) {
            console.log("target_bg from " + target_bg + " to " + adjustedTargetBG + "; ");
            target_bg = adjustedTargetBG;
        } else {
            console.log("target_bg unchanged: " + target_bg + "; ");
        }
        // if eventualBG, naive_eventualBG, and max_bg aren't all above adjustedMaxBG, don’t use it
        if (eventualBG > adjustedMaxBG && naive_eventualBG > adjustedMaxBG && max_bg > adjustedMaxBG) {
            console.error("max_bg from " + max_bg + " to " + adjustedMaxBG);
            max_bg = adjustedMaxBG;
        } else {
            console.error("max_bg unchanged: " + max_bg);
        }
    }

    var expectedDelta = calculate_expected_delta(target_bg, eventualBG, bgi);
    if (typeof eventualBG === 'undefined' || isNaN(eventualBG)) {
        rT.error = 'Error: could not calculate eventualBG. ';
        return rT;
    }

    // min_bg of 90 -> threshold of 65, 100 -> 70 110 -> 75, and 130 -> 85
    //var threshold = Math.max(min_bg - 0.5*(min_bg-40),72); // minimum 72
//    var threshold = Math.max(min_bg-0.5*(min_bg-40), profile.normal_target_bg-9, 75); // minimum 75 or current profile target - 10
    var threshold = (ENWindowOK || ENSleepMode ? Math.max(min_bg - 0.5 * (min_bg - 40), 75) : Math.max(profile.normal_target_bg - 13, 75)); // minimum 75 or current profile target - 13

    //console.error(reservoir_data);

    rT = {
        'temp': 'absolute'
        , 'bg': bg
        , 'tick': tick
        , 'eventualBG': eventualBG
        , 'targetBG': target_bg
        , 'insulinReq': 0
        , 'reservoir': reservoir_data // The expected reservoir volume at which to deliver the microbolus (the reservoir volume from right before the last pumphistory run)
        , 'deliverAt': deliverAt // The time at which the microbolus should be delivered
        , 'sensitivityRatio': sensitivityRatio // autosens ratio (fraction of normal basal)
        , 'variable_sens' : 0
    };

    // generate predicted future BGs based on IOB, COB, and current absorption rate

    var COBpredBGs = [];
    var aCOBpredBGs = [];
    var IOBpredBGs = [];
    var UAMpredBGs = [];
    var ZTpredBGs = [];
    COBpredBGs.push(bg);
    aCOBpredBGs.push(bg);
    IOBpredBGs.push(bg);
    ZTpredBGs.push(bg);
    UAMpredBGs.push(bg);

    var enableSMB = enable_smb(
        profile,
        microBolusAllowed,
        meal_data,
        target_bg
    );

    // enable UAM (if enabled in preferences)
    var enableUAM = (profile.enableUAM);


    //console.error(meal_data);
    // carb impact and duration are 0 unless changed below
    var ci = 0;
    var cid = 0;
    // calculate current carb absorption rate, and how long to absorb all carbs
    // CI = current carb impact on BG in mg/dL/5m
    ci = round((minDelta - bgi), 1);
    var uci = round((minDelta - bgi), 1);
    // ISF (mg/dL/U) / CR (g/U) = CSF (mg/dL/g)

    // TODO: remove commented-out code for old behavior
    //if (profile.temptargetSet) {
    // if temptargetSet, use unadjusted profile.sens to allow activity mode sensitivityRatio to adjust CR
    //var csf = profile.sens / carb_ratio;
    //} else {
    // otherwise, use autosens-adjusted sens to counteract autosens meal insulin dosing adjustments
    // so that autotuned CR is still in effect even when basals and ISF are being adjusted by autosens
    //var csf = sens / carb_ratio;
    //}
    // use autosens-adjusted sens to counteract autosens meal insulin dosing adjustments so that
    // autotuned CR is still in effect even when basals and ISF are being adjusted by TT or autosens
    // this avoids overdosing insulin for large meals when low temp targets are active
    csf = sens / profile.carb_ratio;
    console.error("profile.sens:", profile.sens, "sens:", sens, "CSF:", csf);

    var maxCarbAbsorptionRate = 30; // g/h; maximum rate to assume carbs will absorb if no CI observed
    // limit Carb Impact to maxCarbAbsorptionRate * csf in mg/dL per 5m
    var maxCI = round(maxCarbAbsorptionRate * csf * 5 / 60, 1)
    if (ci > maxCI) {
        console.error("Limiting carb impact from", ci, "to", maxCI, "mg/dL/5m (", maxCarbAbsorptionRate, "g/h )");
        ci = maxCI;
    }
    var remainingCATimeMin = 3; // h; duration of expected not-yet-observed carb absorption
    // adjust remainingCATime (instead of CR) for autosens if sensitivityRatio defined
    if (sensitivityRatio) {
        remainingCATimeMin = remainingCATimeMin / sensitivityRatio;
    }
    // 20 g/h means that anything <= 60g will get a remainingCATimeMin, 80g will get 4h, and 120g 6h
    // when actual absorption ramps up it will take over from remainingCATime
    var assumedCarbAbsorptionRate = 20; // g/h; maximum rate to assume carbs will absorb if no CI observed
    var remainingCATime = remainingCATimeMin;
    if (meal_data.carbs) {
        // if carbs * assumedCarbAbsorptionRate > remainingCATimeMin, raise it
        // so <= 90g is assumed to take 3h, and 120g=4h
        remainingCATimeMin = Math.max(remainingCATimeMin, meal_data.mealCOB / assumedCarbAbsorptionRate);
        var lastCarbAge = round((new Date(systemTime).getTime() - meal_data.lastCarbTime) / 60000);
        //console.error(meal_data.lastCarbTime, lastCarbAge);

        var fractionCOBAbsorbed = (meal_data.carbs - meal_data.mealCOB) / meal_data.carbs;
        remainingCATime = remainingCATimeMin + 1.5 * lastCarbAge / 60;
        remainingCATime = round(remainingCATime, 1);
        //console.error(fractionCOBAbsorbed, remainingCATimeAdjustment, remainingCATime)
        console.error("Last carbs", lastCarbAge, "minutes ago; remainingCATime: ", remainingCATime, "hours;", round(fractionCOBAbsorbed * 100) + "% carbs absorbed");
    }

    // calculate the number of carbs absorbed over remainingCATime hours at current CI
    // CI (mg/dL/5m) * (5m)/5 (m) * 60 (min/hr) * 4 (h) / 2 (linear decay factor) = total carb impact (mg/dL)
    var totalCI = Math.max(0, ci / 5 * 60 * remainingCATime / 2);
    // totalCI (mg/dL) / CSF (mg/dL/g) = total carbs absorbed (g)
    var totalCA = totalCI / csf;
    var remainingCarbsCap = 90; // default to 90
    var remainingCarbsFraction = 1;
    if (profile.remainingCarbsCap) { remainingCarbsCap = Math.min(90, profile.remainingCarbsCap); }
    if (profile.remainingCarbsFraction) { remainingCarbsFraction = Math.min(1, profile.remainingCarbsFraction); }
    var remainingCarbsIgnore = 1 - remainingCarbsFraction;
    var remainingCarbs = Math.max(0, meal_data.mealCOB - totalCA - meal_data.carbs * remainingCarbsIgnore);
    remainingCarbs = Math.min(remainingCarbsCap, remainingCarbs);
    // assume remainingCarbs will absorb in a /\ shaped bilinear curve
    // peaking at remainingCATime / 2 and ending at remainingCATime hours
    // area of the /\ triangle is the same as a remainingCIpeak-height rectangle out to remainingCATime/2
    // remainingCIpeak (mg/dL/5m) = remainingCarbs (g) * CSF (mg/dL/g) * 5 (m/5m) * 1h/60m / (remainingCATime/2) (h)
    var remainingCIpeak = remainingCarbs * csf * 5 / 60 / (remainingCATime / 2);
    //console.error(profile.min_5m_carbimpact,ci,totalCI,totalCA,remainingCarbs,remainingCI,remainingCATime);

    // calculate peak deviation in last hour, and slope from that to current deviation
    var slopeFromMaxDeviation = round(meal_data.slopeFromMaxDeviation, 2);
    // calculate lowest deviation in last hour, and slope from that to current deviation
    var slopeFromMinDeviation = round(meal_data.slopeFromMinDeviation, 2);
    // assume deviations will drop back down at least at 1/3 the rate they ramped up
    var slopeFromDeviations = Math.min(slopeFromMaxDeviation, -slopeFromMinDeviation / 3);
    //console.error(slopeFromMaxDeviation);

    var aci = 10;
    //5m data points = g * (1U/10g) * (40mg/dL/1U) / (mg/dL/5m)
    // duration (in 5m data points) = COB (g) * CSF (mg/dL/g) / ci (mg/dL/5m)
    // limit cid to remainingCATime hours: the reset goes to remainingCI
    if (ci === 0) {
        // avoid divide by zero
        cid = 0;
    } else {
        cid = Math.min(remainingCATime * 60 / 5 / 2, Math.max(0, meal_data.mealCOB * csf / ci));
    }
    var acid = Math.max(0, meal_data.mealCOB * csf / aci);
    // duration (hours) = duration (5m) * 5 / 60 * 2 (to account for linear decay)
    console.error("Carb Impact: ", ci, "mg/dL per 5m; CI Duration: ", round(cid * 5 / 60 * 2, 1), "hours; remaining CI (~2h peak): ", round(remainingCIpeak, 1), "mg/dL per 5m");
    //console.error("Accel. Carb Impact:",aci,"mg/dL per 5m; ACI Duration:",round(acid*5/60*2,1),"hours");
    var minIOBPredBG = 999;
    var minCOBPredBG = 999;
    var minUAMPredBG = 999;
    var minGuardBG = bg;
    var minCOBGuardBG = 999;
    var minUAMGuardBG = 999;
    var minIOBGuardBG = 999;
    var minZTGuardBG = 999;
    var minPredBG;
    var avgPredBG;
    var IOBpredBG = eventualBG;
    var maxIOBPredBG = bg;
    var maxCOBPredBG = bg;
    var maxUAMPredBG = bg;
    //var maxPredBG = bg;
    var eventualPredBG = bg;
    var lastIOBpredBG;
    var lastCOBpredBG;
    var lastUAMpredBG;
    var lastZTpredBG;
    var UAMduration = 0;
    var remainingCItotal = 0;
    var remainingCIs = [];
    var predCIs = [];
    try {
        iobArray.forEach(function (iobTick) {
            //console.error(iobTick);
            var predBGI = round((-iobTick.activity * sens * 5), 2);
            var predZTBGI = round((-iobTick.iobWithZeroTemp.activity * sens * 5), 2);
            // for IOBpredBGs, predicted deviation impact drops linearly from current deviation down to zero
            // over 60 minutes (data points every 5m)
            var predDev = ci * ( 1 - Math.min(1,IOBpredBGs.length/(60/5)) );
            //IOBpredBG = IOBpredBGs[IOBpredBGs.length-1] + predBGI + predDev;
            IOBpredBG = IOBpredBGs[IOBpredBGs.length-1] + (round(( -iobTick.activity * getISFforBG(Math.max(IOBpredBGs[IOBpredBGs.length-1],39)) * 5 ),2)) + predDev; //dynISF
            // calculate predBGs with long zero temp without deviations
            //var ZTpredBG = ZTpredBGs[ZTpredBGs.length-1] + predZTBGI;
            var ZTpredBG = ZTpredBGs[ZTpredBGs.length - 1] + (round((-iobTick.iobWithZeroTemp.activity * getISFforBG(Math.max(ZTpredBGs[ZTpredBGs.length-1],39)) * 5 ), 2)); //dynISF
                        // for COBpredBGs, predicted carb impact drops linearly from current carb impact down to zero
            // eventually accounting for all carbs (if they can be absorbed over DIA)
            var predCI = Math.max(0, Math.max(0, ci) * (1 - COBpredBGs.length / Math.max(cid * 2, 1)));
            var predACI = Math.max(0, Math.max(0, aci) * (1 - COBpredBGs.length / Math.max(acid * 2, 1)));
            // if any carbs aren't absorbed after remainingCATime hours, assume they'll absorb in a /\ shaped
            // bilinear curve peaking at remainingCIpeak at remainingCATime/2 hours (remainingCATime/2*12 * 5m)
            // and ending at remainingCATime h (remainingCATime*12 * 5m intervals)
            var intervals = Math.min(COBpredBGs.length, (remainingCATime * 12) - COBpredBGs.length);
            var remainingCI = Math.max(0, intervals / (remainingCATime / 2 * 12) * remainingCIpeak);
            remainingCItotal += predCI + remainingCI;
            remainingCIs.push(round(remainingCI, 0));
            predCIs.push(round(predCI, 0));
            //console.log(round(predCI,1)+"+"+round(remainingCI,1)+" ");
            COBpredBG = COBpredBGs[COBpredBGs.length - 1] + predBGI + Math.min(0, predDev) + predCI + remainingCI;
            var aCOBpredBG = aCOBpredBGs[aCOBpredBGs.length - 1] + predBGI + Math.min(0, predDev) + predACI;
            // for UAMpredBGs, predicted carb impact drops at slopeFromDeviations
            // calculate predicted CI from UAM based on slopeFromDeviations
            var predUCIslope = Math.max(0, uci + (UAMpredBGs.length * slopeFromDeviations));
            // if slopeFromDeviations is too flat, predicted deviation impact drops linearly from
            // current deviation down to zero over 3h (data points every 5m)
            var predUCImax = Math.max(0, uci * (1 - UAMpredBGs.length / Math.max(3 * 60 / 5, 1)));
            //console.error(predUCIslope, predUCImax);
            // predicted CI from UAM is the lesser of CI based on deviationSlope or DIA
            var predUCI = Math.min(predUCIslope, predUCImax);
            if (predUCI > 0) {
                //console.error(UAMpredBGs.length,slopeFromDeviations, predUCI);
                UAMduration = round((UAMpredBGs.length + 1) * 5 / 60, 1);
            }
            //UAMpredBG = UAMpredBGs[UAMpredBGs.length-1] + predBGI + Math.min(0, predDev) + predUCI;
            UAMpredBG = UAMpredBGs[UAMpredBGs.length-1] + (round(( -iobTick.activity * getISFforBG(Math.max(UAMpredBGs[UAMpredBGs.length-1],39)) * 5 ),2)) + Math.min(0, predDev) + predUCI; //dynISF
            //console.error(predBGI, predCI, predUCI);
            // truncate all BG predictions at 4 hours
            if (IOBpredBGs.length < 48) { IOBpredBGs.push(IOBpredBG); }
            if (COBpredBGs.length < 48) { COBpredBGs.push(COBpredBG); }
            if (aCOBpredBGs.length < 48) { aCOBpredBGs.push(aCOBpredBG); }
            if (UAMpredBGs.length < 48) { UAMpredBGs.push(UAMpredBG); }
            if (ZTpredBGs.length < 48) { ZTpredBGs.push(ZTpredBG); }
            // calculate minGuardBGs without a wait from COB, UAM, IOB predBGs
            if (COBpredBG < minCOBGuardBG) { minCOBGuardBG = round(COBpredBG); }
            if (UAMpredBG < minUAMGuardBG) { minUAMGuardBG = round(UAMpredBG); }
            if (IOBpredBG < minIOBGuardBG) { minIOBGuardBG = round(IOBpredBG); }
            if (ZTpredBG < minZTGuardBG) { minZTGuardBG = round(ZTpredBG); }

            // set minPredBGs starting when currently-dosed insulin activity will peak
            // look ahead 60m (regardless of insulin type) so as to be less aggressive on slower insulins
            var insulinPeakTime = 60;
            // add 30m to allow for insulin delivery (SMBs or temps)
            insulinPeakTime = 90;
            insulinPeakTime = ins_peak; // use insulin peak with onset from insulinType
            var insulinPeak5m = (insulinPeakTime / 60) * 12;
            //console.error(insulinPeakTime, insulinPeak5m, profile.insulinPeakTime, profile.curve);

            // wait 90m before setting minIOBPredBG
            if (IOBpredBGs.length > insulinPeak5m && (IOBpredBG < minIOBPredBG)) { minIOBPredBG = round(IOBpredBG); }
            if (IOBpredBG > maxIOBPredBG) { maxIOBPredBG = IOBpredBG; }
            // wait 85-105m before setting COB and 60m for UAM minPredBGs
            if ((cid || remainingCIpeak > 0) && COBpredBGs.length > insulinPeak5m && (COBpredBG < minCOBPredBG)) { minCOBPredBG = round(COBpredBG); }
            if ((cid || remainingCIpeak > 0) && COBpredBG > maxIOBPredBG) { maxCOBPredBG = COBpredBG; }
            if (enableUAM && UAMpredBGs.length > 12 && (UAMpredBG < minUAMPredBG)) { minUAMPredBG = round(UAMpredBG); }
            if (enableUAM && UAMpredBG > maxIOBPredBG) { maxUAMPredBG = UAMpredBG; }
        });
        // set eventualBG to include effect of carbs
        //console.error("PredBGs:",JSON.stringify(predBGs));
    } catch (e) {
        console.error("Problem with iobArray.  Optional feature Advanced Meal Assist disabled");
    }
    if (meal_data.mealCOB) {
        console.error("predCIs (mg/dL/5m): ", predCIs.join(" "));
        console.error("remainingCIs:       ", remainingCIs.join(" "));
    }
    rT.predBGs = {};
    IOBpredBGs.forEach(function (p, i, theArray) {
        theArray[i] = round(Math.min(401, Math.max(39, p)));
    });
    for (var i = IOBpredBGs.length - 1; i > 12; i--) {
        if (IOBpredBGs[i - 1] !== IOBpredBGs[i]) { break; }
        else { IOBpredBGs.pop(); }
    }
    rT.predBGs.IOB = IOBpredBGs;
    lastIOBpredBG = round(IOBpredBGs[IOBpredBGs.length - 1]);
    ZTpredBGs.forEach(function (p, i, theArray) {
        theArray[i] = round(Math.min(401, Math.max(39, p)));
    });
    for (i = ZTpredBGs.length - 1; i > 6; i--) {
        // stop displaying ZTpredBGs once they're rising and above target
        if (ZTpredBGs[i - 1] >= ZTpredBGs[i] || ZTpredBGs[i] <= target_bg) { break; }
        else { ZTpredBGs.pop(); }
    }
    rT.predBGs.ZT = ZTpredBGs;
    lastZTpredBG = round(ZTpredBGs[ZTpredBGs.length - 1]);
    if (meal_data.mealCOB > 0) {
        aCOBpredBGs.forEach(function (p, i, theArray) {
            theArray[i] = round(Math.min(401, Math.max(39, p)));
        });
        for (i = aCOBpredBGs.length - 1; i > 12; i--) {
            if (aCOBpredBGs[i - 1] !== aCOBpredBGs[i]) { break; }
            else { aCOBpredBGs.pop(); }
        }
    }
    if (meal_data.mealCOB > 0 && (ci > 0 || remainingCIpeak > 0)) {
        COBpredBGs.forEach(function (p, i, theArray) {
            theArray[i] = round(Math.min(401, Math.max(39, p)));
        });
        for (i = COBpredBGs.length - 1; i > 12; i--) {
            if (COBpredBGs[i - 1] !== COBpredBGs[i]) { break; }
            else { COBpredBGs.pop(); }
        }
        rT.predBGs.COB = COBpredBGs;
        lastCOBpredBG = round(COBpredBGs[COBpredBGs.length - 1]);
        if (!ignoreCOB) eventualBG = Math.max(eventualBG, round(COBpredBGs[COBpredBGs.length - 1])); //MD#01: Dont use COB eventualBG if ignoring COB
    }
    if (ci > 0 || remainingCIpeak > 0) {
        if (enableUAM) {
            UAMpredBGs.forEach(function (p, i, theArray) {
                theArray[i] = round(Math.min(401, Math.max(39, p)));
            });
            for (i = UAMpredBGs.length - 1; i > 12; i--) {
                if (UAMpredBGs[i - 1] !== UAMpredBGs[i]) { break; }
                else { UAMpredBGs.pop(); }
            }
            rT.predBGs.UAM = UAMpredBGs;
            lastUAMpredBG = round(UAMpredBGs[UAMpredBGs.length - 1]);
            if (UAMpredBGs[UAMpredBGs.length - 1]) {
                eventualBG = Math.max(eventualBG, round(UAMpredBGs[UAMpredBGs.length - 1]));
            }
        }

        // set eventualBG based on COB or UAM predBGs
        rT.eventualBG = eventualBG;
    }

    console.error("UAM Impact: ", uci, "mg/dL per 5m; UAM Duration: ", UAMduration, "hours");


    minIOBPredBG = Math.max(39, minIOBPredBG);
    minCOBPredBG = Math.max(39, minCOBPredBG);
    minUAMPredBG = Math.max(39, minUAMPredBG);
    minPredBG = round(minIOBPredBG);
    console.error("minIOBPredBG: ", minIOBPredBG, "minCOBPredBG: ", minCOBPredBG, "minUAMPredBG: ", minUAMPredBG, "minPredBG: ", minPredBG);

    var fractionCarbsLeft = meal_data.mealCOB / meal_data.carbs;
    // if we have COB and UAM is enabled, average both
    if (minUAMPredBG < 999 && minCOBPredBG < 999) {
        // weight COBpredBG vs. UAMpredBG based on how many carbs remain as COB
        avgPredBG = round((1 - fractionCarbsLeft) * UAMpredBG + fractionCarbsLeft * COBpredBG);
        // if UAM is disabled, average IOB and COB
    } else if (minCOBPredBG < 999) {
        avgPredBG = round((IOBpredBG + COBpredBG) / 2);
        // if we have UAM but no COB, average IOB and UAM
    } else if (minUAMPredBG < 999) {
        avgPredBG = round((IOBpredBG + UAMpredBG) / 2);
    } else {
        avgPredBG = round(IOBpredBG);
    }
    if (ignoreCOB && enableUAM) avgPredBG = round((IOBpredBG + UAMpredBG) / 2);  //MD#01: If we are ignoring COB and we have UAM, average IOB and UAM as above
    // if avgPredBG is below minZTGuardBG, bring it up to that level
    if (minZTGuardBG > avgPredBG) {
        avgPredBG = minZTGuardBG;
    }

    // if we have both minCOBGuardBG and minUAMGuardBG, blend according to fractionCarbsLeft
    if ((cid || remainingCIpeak > 0)) {
        if (enableUAM) {
            minGuardBG = fractionCarbsLeft * minCOBGuardBG + (1 - fractionCarbsLeft) * minUAMGuardBG;
        } else {
            minGuardBG = minCOBGuardBG;
        }
    } else if (enableUAM) {
        minGuardBG = minUAMGuardBG;
    } else {
        minGuardBG = minIOBGuardBG;
    }
    if (ignoreCOB && enableUAM) minGuardBG = minUAMGuardBG; //MD#01: if we are ignoring COB and have UAM just use minUAMGuardBG as above
    minGuardBG = round(minGuardBG);
    console.error("minCOBGuardBG: ", minCOBGuardBG , "minUAMGuardBG: ", minUAMGuardBG, "minIOBGuardBG: ", minIOBGuardBG, "minGuardBG: ", minGuardBG);

    var minZTUAMPredBG = minUAMPredBG;
    // if minZTGuardBG is below threshold, bring down any super-high minUAMPredBG by averaging
    // this helps prevent UAM from giving too much insulin in case absorption falls off suddenly
    if (minZTGuardBG < threshold) {
        minZTUAMPredBG = (minUAMPredBG + minZTGuardBG) / 2;
        // if minZTGuardBG is between threshold and target, blend in the averaging
    } else if (minZTGuardBG < target_bg) {
        // target 100, threshold 70, minZTGuardBG 85 gives 50%: (85-70) / (100-70)
        var blendPct = (minZTGuardBG - threshold) / (target_bg - threshold);
        var blendedMinZTGuardBG = minUAMPredBG * blendPct + minZTGuardBG * (1 - blendPct);
        minZTUAMPredBG = (minUAMPredBG + blendedMinZTGuardBG) / 2;
        //minZTUAMPredBG = minUAMPredBG - target_bg + minZTGuardBG;
        // if minUAMPredBG is below minZTGuardBG, bring minUAMPredBG up by averaging
        // this allows more insulin if lastUAMPredBG is below target, but minZTGuardBG is still high
    } else if (minZTGuardBG > minUAMPredBG) {
        minZTUAMPredBG = (minUAMPredBG + minZTGuardBG) / 2;
    }
    minZTUAMPredBG = round(minZTUAMPredBG);
    console.error("minUAMPredBG: ", minUAMPredBG, "minZTGuardBG: ", minZTGuardBG, "minZTUAMPredBG: ", minZTUAMPredBG);
    // if any carbs have been entered recently
    if (meal_data.carbs) {

        // if UAM is disabled, use max of minIOBPredBG, minCOBPredBG
        if (!enableUAM && minCOBPredBG < 999) {
            minPredBG = round(Math.max(minIOBPredBG, minCOBPredBG));
            // if we have COB, use minCOBPredBG, or blendedMinPredBG if it's higher
        } else if (minCOBPredBG < 999) {
            // calculate blendedMinPredBG based on how many carbs remain as COB
            var blendedMinPredBG = fractionCarbsLeft * minCOBPredBG + (1 - fractionCarbsLeft) * minZTUAMPredBG;
            // if blendedMinPredBG > minCOBPredBG, use that instead
            minPredBG = round(Math.max(minIOBPredBG, minCOBPredBG, blendedMinPredBG));
            // if carbs have been entered, but have expired, use minUAMPredBG
        } else if (enableUAM) {
            minPredBG = minZTUAMPredBG;
        } else {
            minPredBG = minGuardBG;
        }
        // in pure UAM mode, use the higher of minIOBPredBG,minUAMPredBG
    } else if (enableUAM) {
        minPredBG = round(Math.max(minIOBPredBG, minZTUAMPredBG));
    }
    if (ignoreCOB && enableUAM) minPredBG = round(Math.max(minIOBPredBG, minZTUAMPredBG)); //MD#01 If we are ignoring COB with UAM enabled use pure UAM mode like above

    // make sure minPredBG isn't higher than avgPredBG
    minPredBG = Math.min(minPredBG, avgPredBG);

    console.log("minPredBG: " + minPredBG + " minIOBPredBG: " + minIOBPredBG + " minZTGuardBG: " + minZTGuardBG);
    if (minCOBPredBG < 999) {
        console.log(" minCOBPredBG: " + minCOBPredBG);
    }
    if (minUAMPredBG < 999) {
        console.log(" minUAMPredBG: " + minUAMPredBG);
    }
    console.error(" avgPredBG: ", avgPredBG, "COB: ", meal_data.mealCOB, "/", meal_data.carbs);
    // But if the COB line falls off a cliff, don't trust UAM too much:
    // use maxCOBPredBG if it's been set and lower than minPredBG
    if (maxCOBPredBG > bg && !ignoreCOB) { //MD#01 Only if we aren't using GhostCOB
        minPredBG = Math.min(minPredBG, maxCOBPredBG);
    }

    // minPredBG and eventualBG based dosing - insulinReq_bg
    // insulinReq_sens is calculated using a percentage of eventualBG (eBGweight) with the rest as minPredBG, to reduce the risk of overdosing.
    var insulinReq_bg_orig = Math.min(minPredBG,eventualBG),
        insulinReq_bg = Math.max(insulinReq_bg_orig, 39),
        insulinReq_sens = getISFforBG(bg),
        sens_predType = "NA",
        eBGweight_orig = (minPredBG < eventualBG ? 0 : 1),
        eBGweight = eBGweight_orig;

    // EN TT active and no bolus yet with UAM increase insulinReq_bg to provide initial bolus
    var UAMBGPreBolus = (!UAMCOBPreBolus && ENWindowRunTime < ENWindowDuration && ENWindowRunTime < lastBolusAge && !COB);
    var insulinReq_bg_boost = (UAMBGPreBolus ? profile.UAMbgBoost : 0);

    // categorize the eventualBG prediction type for more accurate weighting
    if (lastUAMpredBG > 0 && eventualBG >= lastUAMpredBG) sens_predType = "UAM"; // UAM or any prediction > UAM is the default
    if (lastCOBpredBG > 0 && eventualBG == lastCOBpredBG) sens_predType = "COB"; // if COB prediction is present eventualBG aligns
    if (UAMBGPreBolus || UAMCOBPreBolus) sens_predType = "UAM+"; // force UAM+ when appropriate

    // UAM+ predtype when sufficient delta and no COB
    if ((profile.EN_UAMPlus_NoENW || ENWindowOK) && ENtimeOK && delta >= 5 && glucose_status.short_avgdelta >= 3 && !COB) {
        if (DeltaPctS > 1 && DeltaPctL > 1.5) sens_predType = "UAM+"; // with acceleration
        if (eventualBG > ISFbgMax && bg < ISFbgMax) sens_predType = "UAM+";    // when predicted high and bg is lower
    }

    // evaluate prediction type and weighting - Only use during day or when its night and TBR only
    if ((ENactive || ENSleepMode || TIR_sens > 1) && profile.use_ebgw) {

        // when a TT starts some treatments will be processed before it starts causing issues later
        if (ENWindowRunTime < 1) sens_predType = "TBR";

        // UAM predictions, no COB or GhostCOB
        if (sens_predType == "UAM+") {
            // increase minPredBG only when a prebolus is OK
            minPredBG = (UAMBGPreBolus || UAMCOBPreBolus ? Math.max(bg,eventualBG) + insulinReq_bg_boost : minPredBG);
            // use the largest starting bg for eBG and trust it
            eventualBG = Math.max(bg,eventualBG) + insulinReq_bg_boost;
            eBGweight = 0.75;
        }

        // UAM predictions, no COB or GhostCOB
        if (sens_predType == "UAM" && (!COB || ignoreCOB)) {
            // positive or negative delta with acceleration and default
            eBGweight = (DeltaPctS > 1.0 || eventualBG > bg ? 0.50 : 0.25);
            // initial delta accelerating UAM+ when in range
            eBGweight += (DeltaPctS > 1.0 && bg < ISFbgMax && eventualBG > threshold && ENWindowOK ? 0.25 : 0);
            // positive or negative delta with acceleration and lower eBG uses TBR - generally for stubborn high bg
            sens_predType = (DeltaPctS > 1.0 && eventualBG < bg && TIR_sens > 1 ? "TBR" : sens_predType);
            // For TBR predtype when stuck high set a higher eventualBG
            eventualBG = (sens_predType == "TBR" ? Math.max(bg,eventualBG) : eventualBG);

            // SAFETY: when not accelerating use TBR
            // sens_predType = (DeltaPctS <= 1.0 ? "BG" : sens_predType);
            //sens_predType = (DeltaPctS <= 1.0 && eventualBG > bg ? "TBR" : sens_predType);
            // SAFETY: high bg with high delta uses current bg, attempts to reduce overcorrection with fast acting carbs
            sens_predType = (bg > ISFbgMax && delta >= 9 && eventualBG > bg? "BG" : sens_predType);
        }

        // COB predictions or UAM with COB
        if (sens_predType == "COB" || (sens_predType == "UAM" && COB)) {
            // positive or negative delta with acceleration and UAM default
            eBGweight = (DeltaPctS > 1.0 && sens_predType == "COB" || eventualBG > bg ? 0.50 : 0.25);
            eBGweight = (DeltaPctS > 1.0 && sens_predType == "UAM" || eventualBG > bg ? 0.50 : eBGweight);
            // positive or negative delta with acceleration and lower eBG uses current BG - generally for stubborn high bg
            // sens_predType = (DeltaPctS > 1.0 && eventualBG < bg ? "TBR" : sens_predType);

            // SAFETY: high bg with high delta uses current bg, attempts to reduce overcorrection with fast acting carbs
            // sens_predType = (bg > ISFbgMax && delta >= 9 && eventualBG > bg? "BG" : sens_predType);
        }

        eBGweight = (sens_predType == "TBR" || sens_predType == "BG"  ? 1 : eBGweight);

        // calculate the prediction bg based on the weightings for minPredBG and eventualBG, if boosting use eventualBG
        insulinReq_bg = (Math.max(minPredBG, 40) * (1 - eBGweight)) + (Math.max(eventualBG, 40) * eBGweight);

        // override and use current bg for insulinReq_bg with TBR and BG predType
        insulinReq_bg = (sens_predType == "BG" ? bg : insulinReq_bg);
        //insulinReq_bg = (sens_predType == "TBR" ? Math.max(bg,insulinReq_bg,eventualBG) : insulinReq_bg);


        // insulinReq_sens determines the ISF used for final insulinReq calc
        //ins_val = (ENtimeOK ?  ins_val : ins_val * 1.25); // weaken overnight
        insulinReq_sens = getISFforBG(insulinReq_bg);

        // use the strongest ISF when ENW active
        insulinReq_sens = (!firstMealWindow && !COB && ENWindowRunTime <= ENWindowDuration ? Math.min(insulinReq_sens, sens) : insulinReq_sens);

        // EXPERIMENTAL FOR DEBUG ONLY
        // insulinReq_sens_ebg = sens_normalTarget / Math.log((eventualBG / ins_val) + 1);
    }

    console.error("insulinReq_bg: ", convert_bg(insulinReq_bg, profile));
    insulinReq_sens = round(insulinReq_sens, 1);
    console.error("insulinReq_sens: ", convert_bg(insulinReq_sens, profile));
    if (insulinReq_sens) rT.variable_sens = insulinReq_sens;

    enlog += "* eBGweight:\n";
    enlog += "sens_predType: " + sens_predType + "\n";
    enlog += "eBGweight final result: " + eBGweight + "\n";
    // END OF Eventual BG based future sensitivity - insulinReq_sens

    rT.COB = meal_data.mealCOB;
    rT.IOB = iob_data.iob;
    rT.reason = "COB: " + round(meal_data.mealCOB, 1) + ", Dev: " + convert_bg(deviation, profile) + ", BGI: " + convert_bg(bgi, profile) + ", Delta: " + glucose_status.delta + "/" + glucose_status.short_avgdelta + "/" + glucose_status.long_avgdelta + "=" + round(DeltaPctS * 100) + "/" + round(DeltaPctL * 100) + "%" + ", ISF: " + convert_bg(sens_normalTarget, profile) + (profile.use_sens_TDD && sens_normalTarget == MaxISF ? "*" : "") + "/" + convert_bg(sens, profile) + "=" + convert_bg(insulinReq_sens, profile) + ", CR: " + round(carb_ratio, 2) + ", Target: " + convert_bg(target_bg, profile) + (target_bg != normalTarget ? "(" + convert_bg(normalTarget, profile) + ")" : "") + ", minPredBG " + convert_bg(minPredBG, profile) + ", minGuardBG " + convert_bg(minGuardBG, profile) + ", IOBpredBG " + convert_bg(lastIOBpredBG, profile) + ", LGS: " + convert_bg(threshold, profile);

    if (lastCOBpredBG > 0) {
        rT.reason += ", " + (ignoreCOB && !ENWindowOK ? "!" : "") + "COBpredBG " + convert_bg(lastCOBpredBG, profile);
    }
    if (lastUAMpredBG > 0) {
        rT.reason += ", UAMpredBG " + convert_bg(lastUAMpredBG, profile);
    }

    // main EN status
    rT.reason += ", EN-" + profile.variant.substring(0,3) + ":";
    if (!ENSleepMode) rT.reason += (ENactive ? "On" : "Off");
    rT.reason += (ENSleepMode ? "Sleep" : "");
    rT.reason += (ENSleepMode ? " (SMB bg>" + convert_bg(SMBbgOffset, profile) + ")" : "");
    if (profile.temptargetSet) rT.reason += (ENTTActive ? " EN-TT" : " TT") + "=" + convert_bg(target_bg, profile);
    rT.reason += (COB && !profile.temptargetSet && !ENWindowOK ? " COB&gt;0" : "");

    // EN window status
    rT.reason += ", ENW: ";
    rT.reason += (ENWindowOK ? "On" : "Off");
    rT.reason += (firstMealWindow ? " Bkfst" : "") + (firstMealScaling ? " " + profile.BreakfastPct + "%" : "");
    rT.reason += (ENWindowOK && ENWindowRunTime <= ENWindowDuration ? " " + round(ENWindowRunTime) + "/" + ENWindowDuration + "m" : "");
    rT.reason += (!ENWTriggerOK && !ENSleepMode ? " IOB&lt;" + round(ENWIOBThreshU, 2) : "");
    rT.reason += (ENWTriggerOK && !ENSleepMode ? " IOB&gt;" + round(ENWIOBThreshU, 2) : "");

    // other EN stuff
    rT.reason += ", eBGw: " + (sens_predType !="NA" ? sens_predType + " " : "") + convert_bg(insulinReq_bg,profile)+ " "+round(eBGweight*100)+"%";
    //rT.reason += (sens_predType !="NA" ? ", eBGw: " + sens_predType + " " +  round(eBGweight*100) + "% ("+convert_bg(insulinReq_bg,profile)+")" : "");
    rT.reason += ", TDD:" + round(TDD, 2) + " " + (profile.sens_TDD_scale != 100 ? profile.sens_TDD_scale + "% " : "") + "(" + convert_bg(sens_TDD, profile) + ")";
    rT.reason += (TIR_sens > 1 ? ", TIRH:" + round(meal_data.TIRW4H) + "/" + round(meal_data.TIRW3H) + "/" + round(meal_data.TIRW2H) +"/"+round(meal_data.TIRW1H) : "");
    //    rT.reason += (TIR_sens <1 ? ", TIRL:" + round(meal_data.TIRW4L) + "/" + round(meal_data.TIRW3L) + "/" + round(meal_data.TIRW2L) +"/"+round(meal_data.TIRW1L) : "");
    if (profile.use_autosens) rT.reason += ", AS: " + round(autosens_data.ratio, 2);
    rT.reason += ", TIRS: " + round(TIR_sens,2);
    rT.reason += ", SR_TDD: " + round(SR_TDD, 2);
    rT.reason += ", SR: " + sensitivityRatio;
    rT.reason += ", LRT: " + round(60 * minAgo);
    rT.reason += "; ";
    rT.reason += (typeof endebug !== 'undefined' ? "** DEBUG:" + endebug + "** ": "");

    // use naive_eventualBG if above 40, but switch to minGuardBG if both eventualBGs hit floor of 39
    var carbsReqBG = naive_eventualBG;
    if (carbsReqBG < 40) {
        carbsReqBG = Math.min(minGuardBG, carbsReqBG);
    }
    var bgUndershoot = threshold - carbsReqBG;
    // calculate how long until COB (or IOB) predBGs drop below min_bg
    var minutesAboveMinBG = 240;
    var minutesAboveThreshold = 240;
    if (meal_data.mealCOB > 0 && (ci > 0 || remainingCIpeak > 0)) {
        for (i = 0; i < COBpredBGs.length; i++) {
            //console.error(COBpredBGs[i], min_bg);
            if (COBpredBGs[i] < min_bg) {
                minutesAboveMinBG = 5 * i;
                break;
            }
        }
        for (i = 0; i < COBpredBGs.length; i++) {
            //console.error(COBpredBGs[i], threshold);
            if (COBpredBGs[i] < threshold) {
                minutesAboveThreshold = 5 * i;
                break;
            }
        }
    } else {
        for (i = 0; i < IOBpredBGs.length; i++) {
            //console.error(IOBpredBGs[i], min_bg);
            if (IOBpredBGs[i] < min_bg) {
                minutesAboveMinBG = 5 * i;
                break;
            }
        }
        for (i = 0; i < IOBpredBGs.length; i++) {
            //console.error(IOBpredBGs[i], threshold);
            if (IOBpredBGs[i] < threshold) {
                minutesAboveThreshold = 5 * i;
                break;
            }
        }
    }

    if (enableSMB && minGuardBG < threshold) {
        console.error("minGuardBG", convert_bg(minGuardBG, profile), "projected below", convert_bg(threshold, profile), "- disabling SMB");
        //rT.reason += "minGuardBG "+minGuardBG+"<"+threshold+": SMB disabled; ";
        enableSMB = false;
    }
    if (maxDelta > 0.30 * bg) {
        console.error("maxDelta", convert_bg(maxDelta, profile), "> 30% of BG", convert_bg(bg, profile), "- disabling SMB");
        rT.reason += "maxDelta " + convert_bg(maxDelta, profile) + " &gt; 30% of BG " + convert_bg(bg, profile) + ": SMB disabled; ";
        enableSMB = false;
    }

    console.error("BG projected to remain above", convert_bg(min_bg, profile), "for", minutesAboveMinBG, "minutes");
    if (minutesAboveThreshold < 240 || minutesAboveMinBG < 60) {
        console.error("BG projected to remain above", convert_bg(threshold, profile), "for", minutesAboveThreshold, "minutes");
    }
    // include at least minutesAboveThreshold worth of zero temps in calculating carbsReq
    // always include at least 30m worth of zero temp (carbs to 80, low temp up to target)
    var zeroTempDuration = minutesAboveThreshold;
    // BG undershoot, minus effect of zero temps until hitting min_bg, converted to grams, minus COB
    var zeroTempEffect = profile.current_basal * sens * zeroTempDuration / 60;
    // don't count the last 25% of COB against carbsReq
    var COBforCarbsReq = Math.max(0, meal_data.mealCOB - 0.25 * meal_data.carbs);
    var carbsReq = (bgUndershoot - zeroTempEffect) / csf - COBforCarbsReq;
    zeroTempEffect = round(zeroTempEffect);
    carbsReq = round(carbsReq);
    console.error("naive_eventualBG: ", naive_eventualBG)
    console.error("bgUndershoot: ", bgUndershoot)
    console.error("zeroTempDuration: ", zeroTempDuration)
    console.error("zeroTempEffect: ", zeroTempEffect)
    console.error("carbsReq: ", carbsReq);
    console.log("=======================");
    console.log("Eating Now Scaled");
    console.log("=======================");
    console.log(enlog);
    console.log("=======================");

    if (carbsReq >= profile.carbsReqThreshold && minutesAboveThreshold <= 45) {
        rT.carbsReq = carbsReq;
        rT.carbsReqWithin = minutesAboveThreshold;
        rT.reason += carbsReq + " add'l carbs req w/in " + minutesAboveThreshold + "m; ";
    }

    // don't low glucose suspend if IOB is already super negative and BG is rising faster than predicted
    if (bg < threshold && iob_data.iob < -profile.current_basal * 20 / 60 && minDelta > 0 && minDelta > expectedDelta) {
        rT.reason += "IOB " + iob_data.iob + " &lt; " + round(-profile.current_basal * 20 / 60, 2);
        rT.reason += " and minDelta " + convert_bg(minDelta, profile) + " &gt; " + "expectedDelta " + convert_bg(expectedDelta, profile) + "; ";
        // predictive low glucose suspend mode: BG is / is projected to be < threshold
    } else if (bg < threshold || minGuardBG < threshold) {
        rT.reason += "minGuardBG " + convert_bg(minGuardBG, profile) + "&lt;" + convert_bg(threshold, profile);
        bgUndershoot = target_bg - minGuardBG;
        var worstCaseInsulinReq = bgUndershoot / sens;
        var durationReq = round(60 * worstCaseInsulinReq / profile.current_basal);
        durationReq = round(durationReq / 30) * 30;
        // always set a 30-120m zero temp (oref0-pump-loop will let any longer SMB zero temp run)
        durationReq = Math.min(120, Math.max(30, durationReq));
        return tempBasalFunctions.setTempBasal(0, durationReq, profile, rT, currenttemp);
    }

    // if not in LGS mode, cancel temps before the top of the hour to reduce beeping/vibration
    // console.error(profile.skip_neutral_temps, rT.deliverAt.getMinutes());
    if (profile.skip_neutral_temps && rT.deliverAt.getMinutes() >= 55) {
        rT.reason += "; Canceling temp at " + rT.deliverAt.getMinutes() + "m past the hour. ";
        return tempBasalFunctions.setTempBasal(0, 0, profile, rT, currenttemp);
    }

    if (eventualBG < min_bg) { // if eventual BG is below target:
        rT.reason += "Eventual BG " + convert_bg(eventualBG, profile) + " &lt; " + convert_bg(min_bg, profile);
        // if 5m or 30m avg BG is rising faster than expected delta
        if (minDelta > expectedDelta && minDelta > 0 && !carbsReq) {
            // if naive_eventualBG < 40, set a 30m zero temp (oref0-pump-loop will let any longer SMB zero temp run)
            if (naive_eventualBG < 40) {
                rT.reason += ", naive_eventualBG &lt; 40. ";
                return tempBasalFunctions.setTempBasal(0, 30, profile, rT, currenttemp);
            }
            if (glucose_status.delta > minDelta) {
                rT.reason += ", but Delta " + convert_bg(tick, profile) + " &gt; expectedDelta " + convert_bg(expectedDelta, profile);
            } else {
                rT.reason += ", but Min. Delta " + minDelta.toFixed(2) + " &gt; Exp. Delta " + convert_bg(expectedDelta, profile);
            }
            if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
                rT.reason += ", temp " + round(currenttemp.rate, 2) + " ~ req " + basal + "U/hr. ";
                return rT;
            } else {
                rT.reason += "; setting current basal of " + basal + " as temp. ";
                return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
            }
        }

        // calculate 30m low-temp required to get projected BG up to target
        // multiply by 2 to low-temp faster for increased hypo safety
        var insulinReq = 2 * Math.min(0, (eventualBG - target_bg) / insulinReq_sens);
        insulinReq = round(insulinReq, 2);
        // calculate naiveInsulinReq based on naive_eventualBG
        var naiveInsulinReq = Math.min(0, (naive_eventualBG - target_bg) / sens);
        naiveInsulinReq = round(naiveInsulinReq, 2);
        if (minDelta < 0 && minDelta > expectedDelta) {
            // if we're barely falling, newinsulinReq should be barely negative
            var newinsulinReq = round((insulinReq * (minDelta / expectedDelta)), 2);
            //console.error("Increasing insulinReq from " + insulinReq + " to " + newinsulinReq);
            insulinReq = newinsulinReq;
        }
        // rate required to deliver insulinReq less insulin over 30m:
        var rate = basal + (2 * insulinReq);
        rate = round_basal(rate, profile);

        // if required temp < existing temp basal
        var insulinScheduled = currenttemp.duration * (currenttemp.rate - basal) / 60;
        // if current temp would deliver a lot (30% of basal) less than the required insulin,
        // by both normal and naive calculations, then raise the rate
        var minInsulinReq = Math.min(insulinReq, naiveInsulinReq);
        if (insulinScheduled < minInsulinReq - basal * 0.3) {
            rT.reason += ", " + currenttemp.duration + "m@" + (currenttemp.rate).toFixed(2) + " is a lot less than needed. ";
            return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
        }
        if (typeof currenttemp.rate !== 'undefined' && (currenttemp.duration > 5 && rate >= currenttemp.rate * 0.8)) {
            rT.reason += ", temp " + round(currenttemp.rate, 2) + " ~&lt; req " + rate + "U/hr. ";
            return rT;
        } else {
            // calculate a long enough zero temp to eventually correct back up to target
            if (rate <= 0) {
                bgUndershoot = target_bg - naive_eventualBG;
                worstCaseInsulinReq = bgUndershoot / sens;
                durationReq = round(60 * worstCaseInsulinReq / profile.current_basal);
                if (durationReq < 0) {
                    durationReq = 0;
                    // don't set a temp longer than 120 minutes
                } else {
                    durationReq = round(durationReq / 30) * 30;
                    durationReq = Math.min(120, Math.max(0, durationReq));
                }
                //console.error(durationReq);
                if (durationReq > 0) {
                    rT.reason += ", setting " + durationReq + "m zero temp. ";
                    return tempBasalFunctions.setTempBasal(rate, durationReq, profile, rT, currenttemp);
                }
            } else {
                rT.reason += ", setting " + round(rate, 3) + "U/hr. ";
            }
            return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
        }
    }

    // if eventual BG is above min but BG is falling faster than expected Delta
    if (minDelta < expectedDelta) {
        // if in SMB mode, don't cancel SMB zero temp
        if (!(microBolusAllowed && enableSMB)) {
            if (glucose_status.delta < minDelta) {
                rT.reason += "Eventual BG " + convert_bg(eventualBG, profile) + " &gt; " + convert_bg(min_bg, profile) + " but Delta " + convert_bg(tick, profile) + " &lt; Exp. Delta " + convert_bg(expectedDelta, profile);
            } else {
                rT.reason += "Eventual BG " + convert_bg(eventualBG, profile) + " &gt; " + convert_bg(min_bg, profile) + " but Min. Delta " + minDelta.toFixed(2) + " &lt; Exp. Delta " + convert_bg(expectedDelta, profile);
            }
            if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
                rT.reason += ", temp " + round(currenttemp.rate, 2) + " ~ req " + basal + "U/hr. ";
                return rT;
            } else {
                rT.reason += "; setting current basal of " + basal + " as temp. ";
                return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
            }
        }
    }
    // eventualBG or minPredBG is below max_bg
    if (Math.min(eventualBG, minPredBG) < max_bg) {
        // if in SMB mode, don't cancel SMB zero temp
        if (!(microBolusAllowed && enableSMB)) {
            rT.reason += convert_bg(eventualBG, profile) + "-" + convert_bg(minPredBG, profile) + " in range: no temp required";
            if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
                rT.reason += ", temp " + round(currenttemp.rate, 2) + " ~ req " + basal + "U/hr. ";
                return rT;
            } else {
                rT.reason += "; setting current basal of " + basal + " as temp. ";
                return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
            }
        }
    }

    // eventual BG is at/above target
    // if iob is over max, just cancel any temps
    if (eventualBG >= max_bg) {
        rT.reason += "Eventual BG " + convert_bg(eventualBG, profile) + " &gt;= " + convert_bg(max_bg, profile) + ", ";
    }
    if (iob_data.iob > max_iob) {
        rT.reason += "IOB " + round(iob_data.iob, 2) + " &gt; max_iob " + max_iob;
        if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
            rT.reason += ", temp " + round(currenttemp.rate, 2) + " ~ req " + basal + "U/hr. ";
            return rT;
        } else {
            rT.reason += "; setting current basal of " + basal + " as temp. ";
            return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
        }
    } else { // otherwise, calculate 30m high-temp required to get projected BG down to target

        // insulinReq is the additional insulin required to get minPredBG down to target_bg
        //console.error(minPredBG,eventualBG);
        //insulinReq = round( (Math.min(minPredBG,eventualBG) - target_bg) / insulinReq_sens, 3);
        insulinReq = round( (insulinReq_bg_orig - target_bg) / sens_profile, 3);

        // keep the original insulinReq for reporting
        var insulinReqOrig = insulinReq;

        // use eBGweight for insulinReq
        insulinReq = (insulinReq_bg - target_bg) / insulinReq_sens;

        // if that would put us over max_iob, then reduce accordingly
        if (insulinReq > max_iob - iob_data.iob) {
            rT.reason += "max_iob " + max_iob + ", ";
            insulinReq = max_iob - iob_data.iob;
        }

        // rate required to deliver insulinReq more insulin over 30m:
        rate = basal + (2 * insulinReq);
        rate = round_basal(rate, profile);
        insulinReq = round(insulinReq, 3);
        rT.insulinReq = insulinReq;
        //console.error(iob_data.lastBolusTime);
        // minutes since last bolus
        var lastBolusAge = round((new Date(systemTime).getTime() - iob_data.lastBolusTime) / 60000, 1);
        var microBolus = 0; //establish no SMB
        //console.error(lastBolusAge);
        //console.error(profile.temptargetSet, target_bg, rT.COB);
        // only allow microboluses with COB or low temp targets, or within DIA hours of a bolus
        if (microBolusAllowed && enableSMB && bg > threshold) {
            var mealInsulinReq = round(meal_data.mealCOB / carb_ratio, 3);
            console.error("IOB", iob_data.iob, "COB", meal_data.mealCOB + "; mealInsulinReq =", mealInsulinReq);
            if (meal_data.mealCOB > 0 && iob_data.iob <= mealInsulinReq) {
                if (typeof profile.maxSMBBasalMinutes === 'undefined') {
                    var maxBolus = round(profile.current_basal * 30 / 60, 1);
                    console.error("profile.maxSMBBasalMinutes undefined: defaulting to 30m");
                }
                else {
                    console.error("profile.maxSMBBasalMinutes:", profile.maxSMBBasalMinutes, "profile.current_basal:", profile.current_basal);
                    maxBolus = round(profile.current_basal * profile.maxSMBBasalMinutes / 60, 1);
                }
            }
            else {
                if (profile.maxUAMSMBBasalMinutes) {
                    console.error("profile.maxUAMSMBBasalMinutes:", profile.maxUAMSMBBasalMinutes, "profile.current_basal:", profile.current_basal);
                    maxBolus = round(profile.current_basal * profile.maxUAMSMBBasalMinutes / 60, 1);
                } else {
                    console.error("profile.maxUAMSMBBasalMinutes undefined: defaulting to 30m");
                    maxBolus = round(profile.current_basal * 30 / 60, 1);
                }
            }

            // ============  EATING NOW MODE  ==================== START ===
            var insulinReqPctDefault = 0.65; // this is the default insulinReqPct and maxBolus is respected outside of eating now
            var insulinReqPct = insulinReqPctDefault; // this is the default insulinReqPct and maxBolus is respected outside of eating now
            var ENReason = "";
            var ENMaxSMB = maxBolus; // inherit AAPS maxBolus
            var maxBolusOrig = maxBolus;
            var ENinsulinReqPct = 0.75; // EN insulinReqPct is 75%
            var ENWinsulinReqPct = 0.85; // ENW insulinReqPct is 85%

            // START === if we are eating now and BGL prediction is higher than normal target ===
            if (ENactive && eventualBG > target_bg) {

                // ============== INSULINREQPCT RESTRICTIONS ==============

                // ENW gets 85%
                if (ENWindowOK) insulinReqPct = ENWinsulinReqPct;
                // SAFETY: Restrict insulinReq when not ENW to lower dynamic insulinReq unless high
                if (!ENWindowOK && TIR_sens ==1) {
                    insulinReqPct = Math.max(insulinReqOrig/insulinReq,maxBolusOrig/insulinReq); // minimum SMB is maxBolusOrig
                    insulinReqPct = Math.max(insulinReqPct,0); // minimum 0% when original insulinReq is much lower
                    insulinReqPct = Math.min(insulinReqPct,1); // maximum 100% when original insulinReq is much higher
                }

                // UAM+ gets higher % when outside ENW if allowed
                insulinReqPct = (!ENWindowOK && profile.EN_UAMPlus_NoENW && sens_predType == "UAM+" ? ENinsulinReqPct : insulinReqPct);

                // UAM+ PreBolus gets 100% insulinReqPct
                insulinReqPct = (UAMBGPreBolus || UAMCOBPreBolus ? 1 : insulinReqPct);

                // set EN SMB limit for COB or UAM
                ENMaxSMB = (sens_predType == "COB" ? profile.EN_COB_maxBolus : profile.EN_UAM_maxBolus);

                // if ENWindowOK allow further increase max of SMB within the window
                if (ENWindowOK) {
                    if (COB && !UAMCOBPreBolus) {
                        ENMaxSMB = (firstMealWindow ? profile.EN_COB_maxBolus_breakfast : profile.EN_COB_maxBolus);
                        //ENReason += ", Recent COB " + (profile.temptargetSet && target_bg == normalTarget ? " + TT" : "") + " ENW-SMB";
                    } else {
                        ENMaxSMB = (firstMealWindow ? profile.EN_UAM_maxBolus_breakfast : profile.EN_UAM_maxBolus);
                        if (UAMBGPreBolus || UAMCOBPreBolus) ENMaxSMB = (!profile.EN_UAMbgBoost_maxBolus ? ENMaxSMB : profile.EN_UAMbgBoost_maxBolus);
                    }
                }

                // ============== MAXBOLUS RESTRICTIONS ==============
                // if ENMaxSMB is more than AAPS safety maxbolus then consider the setting to be minutes
                ENMaxSMB = (ENMaxSMB > profile.safety_maxbolus ? basal * ENMaxSMB / 60 : ENMaxSMB);
                //ENMaxSMB = (ENMaxSMB > profile.safety_maxbolus ? profile.current_basal * ENMaxSMB / 60 : ENMaxSMB);
                // if ENMaxSMB is more than 0 use ENMaxSMB else use AAPS max minutes
                ENMaxSMB = (ENMaxSMB == 0 ? maxBolus : ENMaxSMB);

                // if ENMaxSMB is -1 no SMB
                ENMaxSMB = (ENMaxSMB == -1 ? 0 : ENMaxSMB);

                // TBR only
                ENMaxSMB = (sens_predType == "TBR" ? 0 : ENMaxSMB);

                // if bg numbers resumed after sensor errors dont allow a large SMB
                ENMaxSMB = ( minAgo < 1 && delta == 0 && glucose_status.short_avgdelta == 0 ? maxBolus : ENMaxSMB );

                // if loop ran again without a new bg dont allow a large SMB, use maxBolus, allow 90 seconds
                // ENMaxSMB = (minAgo > 1.5 && !ENTTActive ? maxBolus : ENMaxSMB);

                // ============== DELTA & IOB BASED RESTRICTIONS ==============
                // if the delta is less than 4 and insulinReq_sens is stronger restrict larger SMB
                //if (insulinReq_sens < sens_normalTarget && delta <= 4 && !firstMealScaling) ENMaxSMB = Math.min(maxBolus,ENMaxSMB); // use the most restrictive
                // ===================================================

                if (ENtimeOK) {
                    // increase maxbolus if we are within the hours specified
                    maxBolus = round(ENMaxSMB, 1);
                    insulinReqPct = insulinReqPct;
                } else {
                    // Default insulinReqPct at night
                    insulinReqPct = insulinReqPctDefault;
                    // default SMB
                    maxBolus = round(maxBolus, 1);
                }

                // ============== IOB RESTRICTION  ==============
                if (insulinReq > max_iob - iob_data.iob) {
                    insulinReq = round(max_iob - iob_data.iob, 2);
                }
            }
            // END === if we are eating now and BGL prediction is higher than normal target ===
            // ============  EATING NOW MODE  ==================== END ===

            // boost insulinReq and maxBolus if required limited to ENMaxSMB
            var roundSMBTo = 1 / profile.bolus_increment;
            var microBolus = Math.floor(Math.min(insulinReq * insulinReqPct, maxBolus) * roundSMBTo) / roundSMBTo;

            // calculate a long enough zero temp to eventually correct back up to target
            var smbTarget = target_bg;
            worstCaseInsulinReq = (smbTarget - (naive_eventualBG + minIOBPredBG) / 2) / sens;
            durationReq = round(60 * worstCaseInsulinReq / profile.current_basal);

            // Nightmode TBR when below SMBbgOffset with no low TT / no COB
            if (ENSleepMode) {
                microBolus = 0;
            }

            // if insulinReq > 0 but not enough for a microBolus, don't set an SMB zero temp
            if (insulinReq > 0 && microBolus < profile.bolus_increment) {
                durationReq = 0;
            }

            var smbLowTempReq = 0;
            if (durationReq <= 0) {
                durationReq = 0;
                // don't set an SMB zero temp longer than 60 minutes
            } else if (durationReq >= 30) {
                durationReq = round(durationReq / 30) * 30;
                durationReq = Math.min(60, Math.max(0, durationReq));
            } else {
                // if SMB durationReq is less than 30m, set a nonzero low temp
                smbLowTempReq = round(basal * durationReq / 30, 2);
                durationReq = 30;
            }
            rT.reason += " insulinReq" + (insulinReq_bg_boost > 0  ? "+ " : " ") + insulinReq + (insulinReq != insulinReqOrig ? "(" + insulinReqOrig + ")" : "") + "@"+round(insulinReqPct*100,0)+"%";

            if (microBolus >= maxBolus) {
                rT.reason += "; maxBolus " + maxBolus;
            }
            if (durationReq > 0) {
                rT.reason += "; setting " + durationReq + "m low temp of " + smbLowTempReq + "U/h";
            }
            rT.reason += ". ";
            rT.reason += ENReason;
            rT.reason += ". ";
            rT.reason += (typeof endebug !== 'undefined' ? "** DEBUG:" + endebug + "** ": "");

            //allow SMBs every 3 minutes by default
            var SMBInterval = 3;
            if (profile.SMBInterval) {
                // allow SMBIntervals between 1 and 10 minutes
                SMBInterval = Math.min(10, Math.max(1, profile.SMBInterval));
            }
            var nextBolusMins = round(SMBInterval - lastBolusAge, 0);
            var nextBolusSeconds = round((SMBInterval - lastBolusAge) * 60, 0) % 60;
            //console.error(naive_eventualBG, insulinReq, worstCaseInsulinReq, durationReq);
            console.error("naive_eventualBG", naive_eventualBG + ",", durationReq + "m " + smbLowTempReq + "U/h temp needed; last bolus", lastBolusAge + "m ago; maxBolus: " + maxBolus);
            if (lastBolusAge > SMBInterval) {
                if (microBolus > 0) {
                    rT.units = microBolus;
                    rT.reason += "Microbolusing " + microBolus + "/" + maxBolus + "U.";
                }
            } else {
                rT.reason += "Waiting " + nextBolusMins + "m " + nextBolusSeconds + "s to microbolus again. ";
            }
            //rT.reason += ". ";

            // if no zero temp is required, don't return yet; allow later code to set a high temp
            if (durationReq > 0) {
                rT.rate = smbLowTempReq;
                rT.duration = durationReq;
                return rT;
            }

        }

        var maxSafeBasal = tempBasalFunctions.getMaxSafeBasal(profile);

        // SAFETY: if ENactive and an SMB given reduce the temp rate, unless resistant
        if (microBolus && TIR_sens == 1) {
            rate = Math.max(basal + insulinReq - microBolus, 0);
            rate = round_basal(rate, profile);
        }

        if (rate > maxSafeBasal) {
            rT.reason += "adj. req. rate: " + round(rate, 3) + " to maxSafeBasal: " + maxSafeBasal + ", ";
            rate = round_basal(maxSafeBasal, profile);
        }

        insulinScheduled = currenttemp.duration * (currenttemp.rate - basal) / 60;
        if (insulinScheduled >= rate - basal) { // if current temp would deliver more than the required remaining insulin, lower the rate
            rT.reason += currenttemp.duration + "m@" + (currenttemp.rate).toFixed(2) + " &gt;" + rate + ". Setting temp basal of " + rate + "U/hr. ";
            return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
        }

        if (typeof currenttemp.duration === 'undefined' || currenttemp.duration === 0) { // no temp is set
            rT.reason += "no temp, setting " + rate + "U/hr. ";
            return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
        }

        if (currenttemp.duration > 5 && (round_basal(rate, profile) <= round_basal(currenttemp.rate, profile))) { // if current temp > required temp
            rT.reason += "temp " + round(currenttemp.rate, 2) + " &gt;~ req " + rate + "U/hr. ";
            return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
        }

        // required temp > existing temp basal
        rT.reason += "temp " + round(currenttemp.rate, 2) + " &lt; " + rate + "U/hr. ";
        return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
    }

};

module.exports = determine_basal;
