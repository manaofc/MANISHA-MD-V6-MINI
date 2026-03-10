#!/system/bin/sh

clear

echo ""
echo "======================================"
echo "        ManaOfc Gaming Optimizer"
echo "======================================"
echo ""

sleep 1

# Start Time

start_time=$(date +%s)

echo "Detecting Device Info..."
sleep 1

echo "Brand: $(getprop ro.product.system.brand)"
echo "Model: $(getprop ro.product.model)"
echo "Chipset: $(getprop ro.hardware)"
echo "CPU Cores: $(grep -c processor /proc/cpuinfo)"
echo ""

# RAM Info

TOTAL_RAM=$(grep MemTotal /proc/meminfo | awk '{print $2/1024/1024}')
FREE_RAM=$(grep MemAvailable /proc/meminfo | awk '{print $2/1024/1024}')

echo "Total RAM: ${TOTAL_RAM} GB"
echo "Available RAM: ${FREE_RAM} GB"
echo ""

sleep 1

###################################

# RAM AGGRESSIVE CLEAN

###################################

echo "[1/5] Cleaning RAM..."

am kill-all
sync
echo 3 > /proc/sys/vm/drop_caches 2>/dev/null

sleep 1

FREE_RAM2=$(grep MemAvailable /proc/meminfo | awk '{print $2/1024/1024}')
echo "RAM After Clean: ${FREE_RAM2} GB"
echo ""

###################################

# CPU BOOST

###################################

echo "[2/5] Applying CPU Boost..."

for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
do
echo performance > $cpu 2>/dev/null
done

sleep 1

###################################

# GAMING PERFORMANCE SETTINGS

###################################

echo "[3/5] Applying Gaming Tweaks..."

settings put global animator_duration_scale 0
settings put global transition_animation_scale 0
settings put global window_animation_scale 0

settings put global background_process_limit 2

settings put global activity_manager_constants max_cached_processes=24

###################################

# FPS BOOST

###################################

echo "[4/5] Applying FPS Boost..."

settings put system peak_refresh_rate 120
settings put system min_refresh_rate 60

settings put global game_driver_all_apps 1

###################################

# NETWORK / PING TWEAK

###################################

echo "[5/5] Optimizing Network..."

settings put global tcp_default_init_rwnd 60

settings put global wifi_scan_always_enabled 0

settings put global mobile_data_always_on 0

sleep 1

###################################

# FINAL

###################################

echo ""
echo "Optimization Completed Successfully!"
echo ""

echo "Recommended:"
echo "• Restart Phone"
echo "• Turn on Game Mode before playing"
echo ""

# End Time

end_time=$(date +%s)
runtime=$((end_time - start_time))

echo "Total Script Runtime: $runtime seconds"
echo ""
echo "ManaOfc Optimizer Finished!"
